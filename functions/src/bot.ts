import {
    conversations,
    createConversation,
    type ConversationFlavor,
} from '@grammyjs/conversations';
import { Bot, webhookCallback, type Context } from 'grammy';

import * as logger from 'firebase-functions/logger';
import { setFiltersConversation } from './conversations';
import * as db from './db';
import { getCityDisplayName, getRoomsDisplayName } from './types';
import { mainMenuCustomKeyboard } from './keyboards';

const {
    BOT_TOKEN: token,
    WEBHOOK_URL: webhookUrl,
} = process.env;

const bot = new Bot<ConversationFlavor<Context>>(token!);
bot.use(conversations());
bot.use(createConversation(setFiltersConversation));

/**
 * Creates and configures a webhook for the Telegram bot
 */
export function createWebhook() {
    logger.info('Setting up webhook for Telegram bot...');
    bot.api.setWebhook(webhookUrl!);
    return webhookCallback(bot, 'express');
}

/**
 * Handles the /start command
 */
bot.command('start', async (ctx) => {
    logger.info(`Handling /start command for chat ID: ${ctx.chatId}`);
    const user = await db.getUser(ctx.chatId);
    if (!user) {
        // New user or user without filters, start filter setup
        logger.info(`New user ${ctx.chatId}, start filter setup conversation.`);
        await ctx.reply('👋 *Привет\\!* Давай настроим твой поиск квартир\\.\\.\\.', {
            parse_mode: 'MarkdownV2',
        });
        return ctx.conversation.enter('setFiltersConversation');
    }

    // User exists and has filters set up, show main menu
    logger.info(`User ${ctx.chatId} found, showing current settings.`);

    const { filters } = user;
    const minRentText =
        filters.minCost !== null ? `${filters.minCost} $` : 'не указана';
    const maxRentText =
        filters.maxCost !== null ? `${filters.maxCost} $` : 'не указана';
    const roomsText = filters.rooms.length === 0 ? 'любое' : filters.rooms
        .map((r) => getRoomsDisplayName(r, true))
        .join(', ');

    return ctx.reply(
        '👋 *С возвращением\\!* Вот твои текущие настройки поиска:\n\n' +
        `🗺 *Город:* ${getCityDisplayName(filters.city)}\n` +
        `💰 *Минимальная стоимость:* ${minRentText}\n` +
        `💰 *Максимальная стоимость:* ${maxRentText}\n` +
        `🚪 *Количество комнат:* ${roomsText}\n` +
        `🍠 *Уведомления:* ${user.notificationsEnabled ? 'включены' : 'выключены'}`,
        {
            parse_mode: 'MarkdownV2',
            reply_markup: mainMenuCustomKeyboard(user.notificationsEnabled),
        },
    );
});

bot.hears('Изменить фильтры', async (ctx) => {
    logger.info(`Handling change filters command for chat ID: ${ctx.chatId}`);
    return ctx.conversation.enter('setFiltersConversation');
});

bot.hears(['Включить уведомления', 'Выключить уведомления'], async (ctx) => {
    logger.info(`Handling enable/disable notifications command for chat ID: ${ctx.chatId}`);
    const notificationsEnabled = await db.toggleNotifications(ctx.chatId);
    return ctx.reply(`🍠 *Уведомления:* ${notificationsEnabled ? 'включены' : 'выключены'}`, {
        parse_mode: 'MarkdownV2',
        reply_markup: mainMenuCustomKeyboard(notificationsEnabled),
    });
});
