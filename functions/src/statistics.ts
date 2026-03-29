import * as logger from 'firebase-functions/logger';

import { type Ad, type City, type KufarResponse } from './types';

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

/**
 * Fetches ALL ads for the given city from the Kufar API, paginating through all pages.
 */
export async function fetchAllAds(city: City): Promise<Ad[]> {
    const allAds: Ad[] = [];
    let cursor: string | undefined;

    while (true) {
        const url = makeStatsRequestUrl(city, cursor);
        logger.info(`[statistics] Fetching ads page (accumulated: ${allAds.length})`);
        const response = await fetch(url);
        const data = (await response.json()) as KufarResponse;
        allAds.push(...data.ads);

        // Find the "next" page token
        const nextPage = data.pagination?.pages?.find((p) => p.label === 'next');
        if (!nextPage?.token) break;

        cursor = nextPage.token;
    }

    logger.info(`[statistics] Fetched total ${allAds.length} ads`);
    return allAds;
}

/**
 * Calculates statistics from an array of ads and formats them for Telegram (MarkdownV2).
 */
export function formatStatistics(ads: Ad[], cityDisplayName: string): string {
    if (ads.length === 0) {
        return '📊 *Статистика*\n\nОбъявлений не найдено\\.';
    }

    const prices = ads
        .map((ad) => parseInt(ad.price_usd.slice(0, -2), 10))
        .filter((p) => !isNaN(p) && p > 0 && p < 10000)
        .sort((a, b) => a - b);

    // --- Overall price stats ---
    const minPrice = prices[0];
    const maxPrice = prices[prices.length - 1];
    const avgPrice = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
    const medianPrice =
        prices.length % 2 === 1
            ? prices[Math.floor(prices.length / 2)]
            : Math.round(
                (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2,
            );

    // --- Room distribution ---
    const roomCounts = new Map<string, { count: number; totalPrice: number }>();
    for (const ad of ads) {
        const roomParam = ad.ad_parameters.find((p) => p.p === 'rooms');
        const roomValue = roomParam ? String(roomParam.v) : '?';
        const price = parseInt(ad.price_usd.slice(0, -2), 10);
        const entry = roomCounts.get(roomValue) ?? { count: 0, totalPrice: 0 };
        entry.count++;
        if (!isNaN(price) && price > 0) entry.totalPrice += price;
        roomCounts.set(roomValue, entry);
    }

    const roomLines = [...roomCounts.entries()]
        .sort(([a], [b]) => (a === '?' ? 1 : b === '?' ? -1 : Number(a) - Number(b)))
        .map(([room, { count, totalPrice }]) => {
            const avg = count > 0 ? Math.round(totalPrice / count) : 0;
            const label = room === '?' ? 'Не указано' : `${room}\\-комн\\.`;
            return `  ${label}: ${count} кв\\., \\~${avg}$`;
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
        `  Мин: ${minPrice}$ · Макс: ${maxPrice}$\n` +
        `  Средняя: ${avgPrice}$ · Медиана: ${medianPrice}$\n\n` +
        `🚪 *По комнатам:*\n${roomLines}\n\n` +
        `🏢 *Тип:*\n` +
        `  Собственники: ${ownerCount}\n` +
        `  Агентства: ${agencyCount}`
    );
}

/** Escape special characters for MarkdownV2 */
function escape(text: string): string {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
