import * as logger from 'firebase-functions/logger';

import { getTrackingCity, type MarketStatistics } from './market';
import { marketStore } from './market-tracker';
import { renderPublicationChart } from './publication-chart';
import { fetchAllAds, formatMarketStatistics, formatStatistics } from './statistics';
import { getCityDisplayName, type Ad, type City } from './types';

export interface StatisticsReport {
    text: string;
    photo?: Uint8Array;
}

interface StatisticsReportSource {
    trackedCity: City;
    fetchAds: (city: City) => Promise<Ad[]>;
    loadHistory: (city: City) => Promise<MarketStatistics | null>;
    renderChart: (publications: MarketStatistics['publications']) => Promise<Uint8Array>;
    onHistoryError?: (error: unknown) => void;
    onChartError?: (error: unknown) => void;
}

function defaultSource(): StatisticsReportSource {
    return {
        trackedCity: getTrackingCity(),
        fetchAds: fetchAllAds,
        loadHistory: (city) => marketStore.getStatistics(city),
        renderChart: renderPublicationChart,
        onHistoryError: (error) => logger.error('Error loading market history', error),
        onChartError: (error) => logger.warn('Error rendering publication chart', error),
    };
}

/** The button and evening delivery use the same city-wide report. */
export async function getStatisticsReport(city: City, source = defaultSource()): Promise<StatisticsReport> {
    const ads = await source.fetchAds(city);
    let history: string;
    let publications: MarketStatistics['publications'] | null = null;
    if (city !== source.trackedCity) {
        history = `🕓 История собирается только для города ${getCityDisplayName(source.trackedCity)}\\.`;
    } else {
        try {
            const stats = await source.loadHistory(city);
            history = formatMarketStatistics(stats);
            publications = stats?.publications ?? null;
        } catch (error) {
            source.onHistoryError?.(error);
            history = '🕓 Не удалось загрузить историю объявлений\\. Попробуйте позже\\.';
        }
    }
    const text = `${formatStatistics(ads, getCityDisplayName(city))}\n\n${history}`;
    if (publications === null) return { text };
    if (publications.every((hours) => hours.every((count) => count === 0))) {
        return { text: `${text}\n\n🕒 Пока нет данных о времени публикации\\.` };
    }

    try {
        return { text, photo: await source.renderChart(publications) };
    } catch (error) {
        source.onChartError?.(error);
        return { text: `${text}\n\n🕒 График публикаций временно недоступен\\.` };
    }
}
