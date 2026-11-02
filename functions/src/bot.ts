import {
    conversations,
    createConversation,
    type ConversationFlavor,
} from '@grammyjs/conversations';
import { Bot, webhookCallback, type Context } from 'grammy';
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
import { getTrackingCity } from './market';
import { marketStore } from './market-tracker';
import { fetchAllAds, formatMarketStatistics, formatStatistics } from './statistics';
import { getCityDisplayName, getRoomsDisplayName } from './types';

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

export const sendPhoto = (
    chatId: number,
    imageUrl: string,
    other?: {
        caption?: string,
        parse_mode?: ParseMode,
        reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply,
    }
) => bot.api.sendPhoto(chatId, imageUrl, other);

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

    const msg = await ctx.reply('⏳ Собираю статистику\\.\\.\\.', {
        parse_mode: 'MarkdownV2',
    });

    // Fire-and-forget: compute stats in background to avoid webhook timeout
    fetchAllAds(user.filters.city)
        .then(async (ads) => {
            const cityName = getCityDisplayName(user.filters.city);
            const trackedCity = getTrackingCity();
            let history: string;
            if (user.filters.city !== trackedCity) {
                history = `🕓 История собирается только для города ${getCityDisplayName(trackedCity)}\\.`;
            } else {
                try {
                    history = formatMarketStatistics(await marketStore.getStatistics(trackedCity));
                } catch (error) {
                    logger.error('Error loading market history', error);
                    history = '🕓 Не удалось загрузить историю объявлений\\. Попробуйте позже\\.';
                }
            }
            const text = `${formatStatistics(ads, cityName)}\n\n${history}`;
            return bot.api.editMessageText(ctx.chatId, msg.message_id, text, {
                parse_mode: 'MarkdownV2',
            });
        })
        .catch((error) => {
            logger.error('Error fetching statistics', error);
            return bot.api.editMessageText(
                ctx.chatId,
                msg.message_id,
                '❌ Не удалось получить статистику\\. Попробуйте позже\\.',
                { parse_mode: 'MarkdownV2' },
            );
        });
    return msg;
});
