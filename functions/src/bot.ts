import { Bot, webhookCallback } from 'grammy';

const {
    BOT_TOKEN: botToken,
    WH_URL: whUrl,
} = process.env;

const bot = new Bot(botToken!);

/**
 * Creates and configures a webhook for the Telegram bot
 */
export function createWebhook() {
    bot.api.setWebhook(whUrl!);
    return webhookCallback(bot, 'express');
}

/**
 * Handles the /start command
 */
bot.command('start', (ctx) => ctx.reply('Hello!'));

bot.on(':text', (ctx) => ctx.reply(ctx.msg.text));
