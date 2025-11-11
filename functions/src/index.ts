const env = process.env['FUNCTIONS_EMULATOR'] == 'true' ? 'local' : 'prod';

import dotenv from 'dotenv';
dotenv.config({ path: `.env.${env}` });

import { onRequest } from "firebase-functions/https";
import { createWebhook } from "./bot";

export const tgWebhook = onRequest(createWebhook());
