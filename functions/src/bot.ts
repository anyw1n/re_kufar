import {
    conversations,
    createConversation,
    type ConversationFlavor,
} from '@grammyjs/conversations';
import { Api, Bot, GrammyError, webhookCallback, type Context } from 'grammy';
import {
    type ForceReply,
    type InlineKeyboardMarkup,
    type ParseMode,
    type ReplyKeyboardMarkup,
    type ReplyKeyboardRemove
} from 'grammy/types';

import * as logger from 'firebase-functions/logger';

import { setFiltersConversation } from './conversations';
import * as db from './db';
import { mainMenuCustomKeyboard } from './keyboards';
import { enqueueStatisticsRequest, StatisticsRequestStore } from './statistics-requests';
import { getCityDisplayName, getRoomsDisplayName } from './types';

const { BOT_TOKEN: token } = process.env;

const bot = new Bot<ConversationFlavor<Context>>(token!);
const statisticsApi = new Api(token!, { timeoutSeconds: 30 });
const statisticsRequests = new StatisticsRequestStore(db.db);
bot.use(conversations());
bot.use(createConversation(setFiltersConversation));

/**
 * Creates the Telegram webhook handler. Registration is a deployment step.
 */
export function createWebhook() {
    return webhookCallback(bot, 'express');
}

export const sendPhoto = (
    chatId: number,
    imageUrl: string,
    other?: {
        caption?: string,
        parse_mode?: ParseMode,
        reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply,
    }
) => bot.api.sendPhoto(chatId, imageUrl, other);

export async function sendStatisticsMessage(chatId: number, text: string): Promise<number> {
    const message = await statisticsApi.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    return message.message_id;
}

export async function editStatisticsMessage(chatId: number, messageId: number, text: string): Promise<void> {
    try {
        await statisticsApi.editMessageText(chatId, messageId, text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
        if (error instanceof GrammyError && error.error_code === 400 && error.description.includes('message is not modified')) return;
        throw error;
    }
}

export function isPermanentStatisticsDeliveryError(error: unknown): boolean {
    return error instanceof GrammyError && (error.error_code === 400 || error.error_code === 403);
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
        `💵 *Минимальная стоимость:* ${minRentText}\n` +
        `💰 *Максимальная стоимость:* ${maxRentText}\n` +
        `🚪 *Количество комнат:* ${roomsText}\n` +
        `${user.notificationsEnabled ? '🔔 *Уведомления:* включены' : '🔕 *Уведомления:* выключены'}`,
        {
            parse_mode: 'MarkdownV2',
            reply_markup: mainMenuCustomKeyboard(user.notificationsEnabled),
        },
    );
});

bot.hears('⚙️ Изменить фильтры', async (ctx) => {
    logger.info(`Handling change filters command for chat ID: ${ctx.chatId}`);
    await db.toggleNotifications(ctx.chatId, false);
    await ctx.reply(`🔕 *Уведомления:* выключены`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
            remove_keyboard: true,
        },
    });
    return ctx.conversation.enter('setFiltersConversation');
});

bot.hears(['🔔 Включить уведомления', '🔕 Выключить уведомления'], async (ctx) => {
    logger.info(`Handling enable/disable notifications command for chat ID: ${ctx.chatId}`);
    const notificationsEnabled = await db.toggleNotifications(ctx.chatId);
    return ctx.reply(`${notificationsEnabled ? '🔔 *Уведомления:* включены' : '🔕 *Уведомления:* выключены'}`, {
        parse_mode: 'MarkdownV2',
        reply_markup: mainMenuCustomKeyboard(notificationsEnabled),
    });
});

bot.hears('📊 Статистика', async (ctx) => {
    logger.info(`Handling statistics command for chat ID: ${ctx.chatId}`);
    const user = await db.getUser(ctx.chatId);
    if (!user) {
        return ctx.reply('Сначала настрой фильтры через /start');
    }

    return enqueueStatisticsRequest(String(ctx.update.update_id), ctx.chatId, user.filters.city, {
        store: statisticsRequests,
        showLoading: async () => {
            const message = await ctx.reply('⏳ Собираю статистику\\.\\.\\.', { parse_mode: 'MarkdownV2' });
            return message.message_id;
        },
        removeLoading: (messageId) => ctx.api.deleteMessage(ctx.chatId, messageId),
    });
});
