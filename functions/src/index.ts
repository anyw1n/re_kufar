const env = process.env['FUNCTIONS_EMULATOR'] == 'true' ? 'local' : 'prod';

import dotenv from 'dotenv';
dotenv.config({ path: `.env.${env}` });

import { onRequest } from 'firebase-functions/https';
import { onSchedule } from 'firebase-functions/scheduler';

import { createWebhook } from './bot';
import { checkNewAds } from './parser';
import { trackMarket } from './market-tracker';

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
