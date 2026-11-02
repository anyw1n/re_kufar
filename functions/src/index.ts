const env = process.env['FUNCTIONS_EMULATOR'] == 'true' ? 'local' : 'prod';

import dotenv from 'dotenv';
dotenv.config({ path: `.env.${env}` });

import { onRequest } from 'firebase-functions/https';
import { onSchedule } from 'firebase-functions/scheduler';
import { onDocumentCreated } from 'firebase-functions/firestore';
import * as logger from 'firebase-functions/logger';

import { createWebhook, editStatisticsMessage, isPermanentStatisticsDeliveryError, sendStatisticsMessage } from './bot';
import { deliverDailyStatistics, getDailyStatisticsSchedule } from './daily-statistics';
import { DailyStatisticsStore } from './daily-statistics-store';
import { db } from './db';
import { checkNewAds } from './parser';
import { trackMarket } from './market-tracker';
import { getStatisticsReport } from './statistics-report';
import { processStatisticsRequest, StatisticsRequestStore } from './statistics-requests';

const dailyStatisticsStore = new DailyStatisticsStore(db);
const statisticsRequests = new StatisticsRequestStore(db);

export const statisticsRequestWorker = onDocumentCreated({
    document: 'statisticsRequests/{requestId}',
    timeoutSeconds: 240,
    maxInstances: 2,
    concurrency: 1,
    retry: true,
}, async (event) => {
    const requestId = event.params.requestId;
    const result = await processStatisticsRequest(requestId, {
        store: statisticsRequests,
        loadReport: getStatisticsReport,
        editMessage: editStatisticsMessage,
        isPermanentDeliveryError: isPermanentStatisticsDeliveryError,
        onError: (error) => logger.error('[statistics-request] Processing error', {
            requestId, message: error instanceof Error ? error.message : 'Unknown error',
        }),
    });
    logger.info('[statistics-request] Processing complete', { requestId, result });
});

async function sendDailyStatistics(scheduleTime: string): Promise<void> {
    const totals = await deliverDailyStatistics(scheduleTime, {
        repository: dailyStatisticsStore,
        loadReport: getStatisticsReport,
        sendReport: sendStatisticsMessage,
        onError: (chatId, error) => logger.error('[daily-statistics] Delivery failed', {
            chatId, message: error instanceof Error ? error.message : 'Unknown error',
        }),
    });
    logger.info('[daily-statistics] Delivery complete', totals);
}

export const tgWebhook = onRequest(createWebhook());

export const kufarScraper = env === 'prod'
    ? onSchedule('* * * * *', checkNewAds)
    : onRequest((_req, res) => {
        checkNewAds();
        res.send('OK');
    });

export const marketTracker = env === 'prod'
    ? onSchedule({
        schedule: '0 * * * *',
        timeZone: 'Europe/Minsk',
        timeoutSeconds: 540,
        maxInstances: 1,
        concurrency: 1,
        retryCount: 0,
    }, trackMarket)
    : onRequest({ timeoutSeconds: 540 }, async (_req, res) => {
        try {
            await trackMarket();
            res.send('OK');
        } catch (error) {
            console.error('Market tracking failed', error);
            res.status(500).send('Market tracking failed');
        }
    });

export const dailyStatistics = env === 'prod'
    ? onSchedule({
        schedule: getDailyStatisticsSchedule(),
        timeZone: 'Europe/Minsk',
        timeoutSeconds: 540,
        maxInstances: 1,
        concurrency: 1,
        retryCount: 3,
        minBackoffSeconds: 180,
        maxBackoffSeconds: 600,
    }, (event) => sendDailyStatistics(event.scheduleTime))
    : onRequest({ timeoutSeconds: 540 }, async (_req, res) => {
        try {
            await sendDailyStatistics(new Date().toISOString());
            res.send('OK');
        } catch (error) {
            logger.error('Daily statistics failed', error);
            res.status(500).send('Daily statistics failed');
        }
    });
