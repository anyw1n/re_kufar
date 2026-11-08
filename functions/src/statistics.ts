import { setTimeout as delay } from 'node:timers/promises';
import * as logger from 'firebase-functions/logger';

import { type MarketStatistics, type PeriodStatistics } from './market';
import { getRoomsDisplayName, Rooms, type Ad, type City, type KufarResponse } from './types';

export interface PriceStatistics {
    count: number;
    min: number;
    max: number;
    average: number;
    median: number;
    p10: number;
    p25: number;
    p75: number;
    p90: number;
}

/** Converts integer USD cents to dollars, keeping prices within the statistics range. */
function getValidPrice(ad: Ad): number | null {
    if (!/^\d+$/.test(ad.price_usd)) return null;

    const cents = Number(ad.price_usd);
    const price = cents / 100;
    return Number.isSafeInteger(cents) && price > 0 && price < 10000 ? price : null;
}

/** Linearly interpolates a percentile at index (n - 1) * probability in a sorted sample. */
function percentile(prices: readonly number[], probability: number): number {
    const index = (prices.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return prices[lower] + (prices[upper] - prices[lower]) * (index - lower);
}

/** Calculates price statistics in USD without rounding or changing the input ads. */
export function calculatePriceStatistics(ads: readonly Ad[]): PriceStatistics | null {
    const prices = ads
        .map(getValidPrice)
        .filter((price): price is number => price !== null)
        .sort((a, b) => a - b);

    if (prices.length === 0) return null;

    return {
        count: prices.length,
        min: prices[0],
        max: prices[prices.length - 1],
        average: prices.reduce((sum, price) => sum + price, 0) / prices.length,
        median: percentile(prices, 0.5),
        p10: percentile(prices, 0.1),
        p25: percentile(prices, 0.25),
        p75: percentile(prices, 0.75),
        p90: percentile(prices, 0.9),
    };
}

/**
 * Builds a Kufar API URL for fetching all ads in the given city (no price/room filters).
 */
const makeStatsRequestUrl = (city: City, cursor?: string): string => {
    let url =
        'https://api.kufar.by/search-api/v2/search/rendered-paginated' +
        '?cat=1010' +
        '&cur=USD' +
        `&gtsy=country-belarus~${city}` +
        '&lang=ru' +
        '&size=200' +
        '&typ=let';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    return url;
};

class IncompleteKufarObservationError extends Error {}

class TemporaryKufarHttpError extends Error {
    constructor(message: string, readonly retryAfterMs = 0) {
        super(message);
    }
}

async function fetchAdsPage(url: string, fetcher: typeof fetch, deadline: number): Promise<KufarResponse> {
    let attempt = 0;
    while (true) {
        try {
            const timeout = Math.min(20000, deadline - Date.now());
            if (timeout <= 0) throw new Error('Kufar observation deadline exceeded');
            const response = await fetcher(url, { signal: AbortSignal.timeout(timeout) });
            if (!response.ok) {
                await response.body?.cancel();
                const message = `Kufar returned HTTP ${response.status}`;
                if (response.status === 408 || response.status === 429 || response.status >= 500) {
                    const retryAfter = Number(response.headers.get('retry-after'));
                    throw new TemporaryKufarHttpError(message,
                        Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0);
                }
                throw new Error(message);
            }
            return await response.json() as KufarResponse;
        } catch (error) {
            const temporary = error instanceof TemporaryKufarHttpError || error instanceof TypeError ||
                (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
            const backoff = Math.max(250 * (attempt + 1), error instanceof TemporaryKufarHttpError ? error.retryAfterMs : 0);
            if (!temporary || ++attempt >= 3 || Date.now() + backoff >= deadline) throw error;
            logger.warn('[statistics] Retrying a temporary Kufar page failure', {
                attempt, reason: error instanceof Error ? error.message : 'Unknown error',
            });
            await delay(backoff);
        }
    }
}

async function fetchAdsSnapshot(city: City, fetcher: typeof fetch, deadline: number): Promise<Ad[]> {
    const allAds = new Map<number, Ad>();
    const cursors = new Set<string>();
    let expectedTotal = 0;
    let cursor: string | undefined;
    let pageCount = 0;

    while (true) {
        if (++pageCount > 200 || Date.now() > deadline) {
            throw new Error('Kufar pagination exceeded the observation limit');
        }
        const url = makeStatsRequestUrl(city, cursor);
        logger.info(`[statistics] Fetching ads page (accumulated: ${allAds.size})`);
        const data = await fetchAdsPage(url, fetcher, deadline);
        if (!data || !Array.isArray(data.ads) || !Number.isSafeInteger(data.total) || data.total < data.ads.length) {
            throw new Error('Invalid Kufar ads response');
        }
        expectedTotal = Math.max(expectedTotal, data.total);
        for (const ad of data.ads) {
            if (!ad || !Number.isSafeInteger(ad.ad_id) || ad.ad_id <= 0) {
                throw new Error('Invalid Kufar ad ID');
            }
            allAds.set(ad.ad_id, ad);
        }

        if (data.pagination && !Array.isArray(data.pagination.pages)) {
            throw new Error('Invalid Kufar pagination');
        }

        // Find the "next" page token
        const nextPage = data.pagination?.pages?.find((p) => p.label === 'next');
        if (!nextPage?.token) break;
        if (typeof nextPage.token !== 'string' || cursors.has(nextPage.token) || data.ads.length === 0) {
            throw new Error('Invalid or repeating Kufar pagination cursor');
        }

        cursors.add(nextPage.token);
        cursor = nextPage.token;
    }

    if (allAds.size < expectedTotal) {
        throw new IncompleteKufarObservationError(
            `Incomplete Kufar observation: ${allAds.size} of at least ${expectedTotal} ads`,
        );
    }
    logger.info(`[statistics] Fetched total ${allAds.size} ads`);
    return [...allAds.values()];
}

/** Fetches a complete city, restarting up to twice if live catalog changes truncate the sample. */
export async function fetchAllAds(city: City, fetcher: typeof fetch = fetch): Promise<Ad[]> {
    const deadline = Date.now() + 3 * 60 * 1000;
    let attempts = 0;
    while (true) {
        try {
            return await fetchAdsSnapshot(city, fetcher, deadline);
        } catch (error) {
            if (!(error instanceof IncompleteKufarObservationError) || ++attempts >= 3 || Date.now() >= deadline) {
                throw error;
            }
            logger.warn('[statistics] Incomplete live catalog, restarting observation', {
                city, attempt: attempts, reason: error.message,
            });
        }
    }
}

/**
 * Calculates statistics from an array of ads and formats them for Telegram (MarkdownV2).
 */
export function formatStatistics(ads: Ad[], cityDisplayName: string): string {
    if (ads.length === 0) {
        return '📊 *Статистика*\n\nОбъявлений не найдено\\.';
    }

    const priceStats = calculatePriceStatistics(ads);
    const priceLines = priceStats
        ? `  min: ${Math.round(priceStats.min)}$ • max: ${Math.round(priceStats.max)}$ • av: ${Math.round(priceStats.average)}$\n` +
        `  P25: ${Math.round(priceStats.p25)}$ • P50: ${Math.round(priceStats.median)}$ • P75: ${Math.round(priceStats.p75)}$\n` +
        `  P10: ${Math.round(priceStats.p10)}$ • P90: ${Math.round(priceStats.p90)}$`
        : '  Нет объявлений с подходящей ценой\\.';

    // --- Room distribution ---
    const roomGroups = new Map<string, Ad[]>();
    for (const ad of ads) {
        const roomParam = ad.ad_parameters.find((p) => p.p === 'rooms');
        const roomValue = roomParam ? String(roomParam.v) : '?';
        const group = roomGroups.get(roomValue) ?? [];
        group.push(ad);
        roomGroups.set(roomValue, group);
    }

    const roomLines = [...roomGroups.entries()]
        .sort(([a], [b]) => (a === '?' ? 1 : b === '?' ? -1 : Number(a) - Number(b)))
        .map(([room, group]) => {
            const prices = calculatePriceStatistics(group);
            const priceText = prices
                ? `\\~${Math.round(prices.average)}$ • P50: ${Math.round(prices.median)}$`
                : 'нет подходящих цен';
            const label = room === Rooms.Studio ? getRoomsDisplayName(Rooms.Studio)
                : room === '?' ? 'Не указано' : `${room}-комн.`;
            return `  ${escape(label)}: ${group.length} кв\\., ${priceText}`;
        })
        .join('\n');

    // --- Owner vs Agency ---
    const agencyCount = ads.filter((ad) => ad.company_ad).length;
    const ownerCount = ads.length - agencyCount;

    const adCounts = escape(`${ads.length} об. (с: ${ownerCount}, а: ${agencyCount})`);
    return (
        `📊 *${escape(cityDisplayName)}*, ${adCounts}\n` +
        `_${escape(new Date().toLocaleString('ru-BY', { timeZone: 'Europe/Minsk' }))}_\n\n` +
        `💵 *Цены \\(USD\\):*\n` +
        `${priceLines}\n\n` +
        `🚪 *По комнатам:*\n${roomLines}`
    );
}

function formatMarketPeriod(label: string, period: PeriodStatistics): string {
    const counts = escape(`+${period.newAds} / -${period.disappearedAds}`);
    const ratio = period.ratio === null ? '—' : escape(`~${period.ratio.toFixed(2)}`);
    return `  *${label}:* ${counts}, ${ratio}`;
}

export function formatMarketStatistics(stats: MarketStatistics | null): string {
    const heading = '🕓 *История объявлений:*\n';
    if (stats === null) return heading + 'Ожидается первый успешный обход\\.';

    const dailyEntries = stats.daily.map((day) => {
        const date = day.date.split('-').slice(1).reverse().join('.');
        const counts = day.snapshots === 0 ? 'н/н' : `+${day.newAds} / −${day.disappearedAds}`;
        return escape(`${date}: ${counts}`);
    });
    const dailyLines: string[] = [];
    for (let index = 0; index < dailyEntries.length; index += 2) {
        dailyLines.push(`  ${dailyEntries.slice(index, index + 2).join(' • ')}`);
    }
    const median = stats.medianLifetimeDays;
    const lifetime = median === null ? '—' : escape(`${median < 0.1 ? '<0.1' : median.toFixed(1)} дн.`);
    const partial = stats.partialWeek
        ? `\n  _${stats.partialDay ? 'История за 24 часа и 7 дней пока неполная' : 'История за 7 дней пока неполная'}\\._`
        : '';

    return heading +
        `${formatMarketPeriod('24ч', stats.day)}\n` +
        `${formatMarketPeriod('7д', stats.week)}\n` +
        `  *Вернулись за 7 дней:* ${stats.week.returnedAds}\n` +
        `  *Среднее время жизни:* ${lifetime}${partial}\n\n` +
        dailyLines.join('\n');
}

/** Escape special characters for MarkdownV2 */
function escape(text: string): string {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
