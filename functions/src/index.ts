const env = process.env['FUNCTIONS_EMULATOR'] == 'true' ? 'local' : 'prod';

import dotenv from 'dotenv';
dotenv.config({ path: `.env.${env}` });

import { onRequest } from 'firebase-functions/https';
import { onSchedule } from 'firebase-functions/scheduler';

import { createWebhook } from './bot';
import { checkNewAds } from './parser';

export const tgWebhook = onRequest(createWebhook());

export const kufarScraper = env === 'prod'
    ? onSchedule('* * * * *', checkNewAds)
    : onRequest((_req, res) => {
        checkNewAds();
        res.send('OK');
    });
