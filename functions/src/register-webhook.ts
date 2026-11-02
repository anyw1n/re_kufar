import dotenv from 'dotenv';
import { Api } from 'grammy';

dotenv.config({ path: '.env.prod' });

async function registerWebhook(): Promise<void> {
    const { BOT_TOKEN, WEBHOOK_URL } = process.env;
    if (!BOT_TOKEN || !WEBHOOK_URL) throw new Error('BOT_TOKEN and WEBHOOK_URL are required');
    const api = new Api(BOT_TOKEN, { timeoutSeconds: 30 });
    await api.setWebhook(WEBHOOK_URL);
    console.log('Telegram webhook registered');
}

registerWebhook().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Webhook registration failed');
    process.exitCode = 1;
});
