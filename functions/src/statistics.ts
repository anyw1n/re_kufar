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
        ? `  Объявлений в расчёте: ${priceStats.count}\n` +
        `  Мин: ${Math.round(priceStats.min)}$ · Макс: ${Math.round(priceStats.max)}$\n` +
        `  Средняя: ${Math.round(priceStats.average)}$ · Медиана: ${Math.round(priceStats.median)}$\n\n` +
        `📈 *Перцентили цен:*\n` +
        `  P10: ${Math.round(priceStats.p10)}$ · P25: ${Math.round(priceStats.p25)}$\n` +
        `  P75: ${Math.round(priceStats.p75)}$ · P90: ${Math.round(priceStats.p90)}$\n` +
        `  _P10 — граница нижних 10% цен; аналогично для P25, P75 и P90\\._`
        : '  Нет объявлений с подходящей ценой\\.';

    // --- Room distribution ---
    const roomCounts = new Map<string, { count: number; totalPrice: number; pricedCount: number }>();
    for (const ad of ads) {
        const roomParam = ad.ad_parameters.find((p) => p.p === 'rooms');
        const roomValue = roomParam ? String(roomParam.v) : '?';
        const price = getValidPrice(ad);
        const entry = roomCounts.get(roomValue) ?? { count: 0, totalPrice: 0, pricedCount: 0 };
        entry.count++;
        if (price !== null) {
            entry.totalPrice += price;
            entry.pricedCount++;
        }
        roomCounts.set(roomValue, entry);
    }

    const roomLines = [...roomCounts.entries()]
        .sort(([a], [b]) => (a === '?' ? 1 : b === '?' ? -1 : Number(a) - Number(b)))
        .map(([room, { count, totalPrice, pricedCount }]) => {
            const priceText = pricedCount > 0
                ? `\\~${Math.round(totalPrice / pricedCount)}$`
                : 'нет подходящих цен';
            const label = room === Rooms.Studio ? getRoomsDisplayName(Rooms.Studio)
                : room === '?' ? 'Не указано' : `${room}\\-комн\\.`;
            return `  ${label}: ${count} кв\\., ${priceText}`;
        })
        .join('\n');

    // --- Owner vs Agency ---
    const agencyCount = ads.filter((ad) => ad.company_ad).length;
    const ownerCount = ads.length - agencyCount;

    // --- Format ---
    return (
        `📊 *Статистика: ${escape(cityDisplayName)}*\n` +
        `_${escape(new Date().toLocaleString('ru-BY', { timeZone: 'Europe/Minsk' }))}_\n\n` +
        `🏠 *Всего объявлений:* ${ads.length}\n\n` +
        `💵 *Цены \\(USD\\):*\n` +
        `${priceLines}\n\n` +
        `🚪 *По комнатам:*\n${roomLines}\n\n` +
        `🏢 *Тип:*\n` +
        `  Собственники: ${ownerCount}\n` +
        `  Агентства: ${agencyCount}`
    );
}

function formatMarketPeriod(label: string, period: PeriodStatistics): string {
    const ratio = period.ratio === null
        ? 'не определено \\(исчезнувших нет\\)'
        : escape(period.ratio.toFixed(2).replace('.', ','));
    return `  *${label}:* новых ${period.newAds}, исчезнувших ${period.disappearedAds}\n` +
        `  Новые / исчезнувшие: ${ratio}`;
}

export function formatMarketStatistics(stats: MarketStatistics | null): string {
    const heading = '🕓 *История объявлений:*\n';
    if (stats === null) return heading + 'Ожидается первый успешный обход\\.';

    const started = new Date(stats.trackingStartedAt).toLocaleString('ru-BY', { timeZone: 'Europe/Minsk' });
    const updated = new Date(stats.lastSnapshotAt).toLocaleString('ru-BY', { timeZone: 'Europe/Minsk' });
    const dailyLines = stats.daily.map((day) => {
        const date = day.date.split('-').slice(1).reverse().join('.');
        const counts = day.snapshots === 0 ? 'нет наблюдений' : `+${day.newAds} / −${day.disappearedAds}`;
        return `  ${escape(`${date}: ${counts}`)}`;
    }).join('\n');
    const lifetime = stats.medianLifetimeDays === null
        ? 'пока нет завершённых наблюдений с известным началом'
        : escape(`~${stats.medianLifetimeDays < 0.1 ? '<0,1' : stats.medianLifetimeDays.toFixed(1).replace('.', ',')} дн.`) +
        ` \\(наблюдений: ${stats.lifetimeSampleSize}\\)`;
    const partial = stats.partialWeek
        ? `\n_${stats.partialDay ? 'История за 24 часа и 7 дней пока неполная' : 'История за 7 дней пока неполная'}\\._`
        : '';

    return heading +
        `  Наблюдаем с: ${escape(started)}\n` +
        `  Последний обход: ${escape(updated)}\n\n` +
        `${formatMarketPeriod('За 24 часа', stats.day)}\n\n` +
        `${formatMarketPeriod('За 7 дней', stats.week)}\n` +
        `  Вернулись за 7 дней: ${stats.week.returnedAds}\n\n` +
        `📅 *По дням: новые / исчезнувшие*\n${dailyLines}\n\n` +
        `⏳ *Медианное время до исчезновения за 7 дней:*\n  ${lifetime}\n` +
        `_Медиана — по завершённым наблюдениям с известным началом и без долгих перерывов\\._\n` +
        `_Исчезновение подтверждаем двумя обходами; оно не подтверждает аренду\\._` + partial;
}

/** Escape special characters for MarkdownV2 */
function escape(text: string): string {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
