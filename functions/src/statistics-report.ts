import * as logger from 'firebase-functions/logger';

import { getTrackingCity, type MarketStatistics } from './market';
import { marketStore } from './market-tracker';
import { fetchAllAds, formatMarketStatistics, formatPublicationStatistics, formatStatistics } from './statistics';
import { getCityDisplayName, type Ad, type City } from './types';

interface StatisticsReportSource {
    trackedCity: City;
    fetchAds: (city: City) => Promise<Ad[]>;
    loadHistory: (city: City) => Promise<MarketStatistics | null>;
    onHistoryError?: (error: unknown) => void;
}

function defaultSource(): StatisticsReportSource {
    return {
        trackedCity: getTrackingCity(),
        fetchAds: fetchAllAds,
        loadHistory: (city) => marketStore.getStatistics(city),
        onHistoryError: (error) => logger.error('Error loading market history', error),
    };
}

/** The button and evening delivery use the same city-wide report. */
export async function getStatisticsReport(city: City, source = defaultSource()): Promise<string> {
    const ads = await source.fetchAds(city);
    let history: string;
    if (city !== source.trackedCity) {
        history = `🕓 История собирается только для города ${getCityDisplayName(source.trackedCity)}\\.`;
    } else {
        try {
            const stats = await source.loadHistory(city);
            history = formatMarketStatistics(stats);
            if (stats !== null) history += `\n\n${formatPublicationStatistics(stats.publications)}`;
        } catch (error) {
            source.onHistoryError?.(error);
            history = '🕓 Не удалось загрузить историю объявлений\\. Попробуйте позже\\.';
        }
    }
    return `${formatStatistics(ads, getCityDisplayName(city))}\n\n${history}`;
}
