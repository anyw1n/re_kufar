import { type Conversation } from '@grammyjs/conversations';
import { type Context } from 'grammy';
import * as logger from 'firebase-functions/logger';

import * as db from './db';
import { City, getCityDisplayName, getRoomsDisplayName, Rooms } from './types';
import { mainMenuCustomKeyboard } from './keyboards';

type LogType = 'i' | 'w';

export async function setFiltersConversation(conversation: Conversation, ctx: Context) {
    async function log(type: LogType, message: string) {
        await conversation.external(() => {
            const msg = `[chatId:${ctx.chatId}] ${message}`;
            switch (type) {
                case 'i':
                    logger.info(msg);
                    break;
                case 'w':
                    logger.warn(msg);
                    break;
            }
        })
    }

    // Step 1: Select city
    await log('i', `Start city selection.`);
    const city = await askForCity(conversation, ctx, log);
    await log('i', `City selected: ${city}`);

    // Step 2: Minimum cost
    await log('i', `Start min rent cost input.`);
    const minCost = await askForMinRentCost(conversation, ctx, log);
    await log('i', `Min rent cost: ${minCost}`);

    // Step 3: Maximum cost
    await log('i', `Start max rent cost input.`);
    const maxCost = await askForMaxRentCost(conversation, ctx, minCost, log);
    await log('i', `Max rent cost: ${maxCost}`);

    // Step 4: Room count
    await log('i', `Start room count selection.`);
    const rooms = await askForRoomCount(conversation, ctx, log);
    await log('i', `Room count selected: ${rooms.join(', ')}`);

    // Save filters
    const filters = { city, minCost, maxCost, rooms };
    const chatId = ctx.chatId!;
    const user = await conversation.external(() => db.getUser(chatId));
    await log('i', `Saving filters for user. New user: ${!user}`);
    await conversation.external(() => user ? db.updateUserFilters(chatId, filters) : db.saveUser({
        chatId,
        filters,
        notificationsEnabled: true,
        lastAdTime: null,
    }));

    const minRentText =
        minCost !== null ? `${minCost} $` : 'не указана';
    const maxRentText =
        maxCost !== null ? `${maxCost} $` : 'не указана';
    const roomsText = rooms.length === 0 ? 'любое' : rooms
        .map((r) => getRoomsDisplayName(r, true))
        .join(', ');
    await log('i', `Replying with success message.`);
    await ctx.reply(
        '✅ *Фильтры успешно сохранены\\!*\n\n' +
        `🗺 *Город:* ${getCityDisplayName(city)}\n` +
        `💵 *Минимальная стоимость:* ${minRentText ?? 'не указана'}\n` +
        `💰 *Максимальная стоимость:* ${maxRentText ?? 'не указана'}\n` +
        `🚪 *Количество комнат:* ${roomsText}`,
        {
            reply_markup: { remove_keyboard: true },
            parse_mode: 'MarkdownV2',
        }
    );
    return ctx.reply('Ждём новых объявлений...', {
        reply_markup: mainMenuCustomKeyboard(true),
    });
}

async function askForCity(
    conversation: Conversation,
    ctx: Context,
    log: (type: LogType, message: string) => Promise<void>,
): Promise<City> {
    await ctx.reply('🗺 В каком *городе* ищете недвижимость?', {
        reply_markup: {
            inline_keyboard: Object.values(City).map((city) => [{
                text: getCityDisplayName(city),
                callback_data: city,
            }]),
            remove_keyboard: true,
        },
        parse_mode: 'MarkdownV2',
    });

    // Wait for city callback query using waitForCallbackQuery
    const cityCtx = await conversation.waitForCallbackQuery(Object.values(City));
    await log('i', `City callback query received: ${cityCtx.callbackQuery.data}`);
    await cityCtx.answerCallbackQuery();
    return cityCtx.callbackQuery.data as City;
}

async function askForMinRentCost(
    conversation: Conversation,
    ctx: Context,
    log: (type: LogType, message: string) => Promise<void>,
): Promise<number | null> {
    while (true) {
        await ctx.reply('💵 Укажите *минимальную* сумму арендного платежа в USD или пропустите', {
            reply_markup: {
                keyboard: [[{ text: 'Пропустить' }]],
                resize_keyboard: true,
            },
            parse_mode: 'MarkdownV2',
        });
        const minCostCtx = await conversation.waitFor(':text');
        const minCostText = minCostCtx.msg.text.trim().toLowerCase();
        await log('i', `Received min cost text: "${minCostText}"`);

        if (minCostText === '0' || minCostText === 'пропустить') {
            await log('i', `Min cost skipped.`);
            return null;
        }

        const minCost = parseInt(minCostText);
        if (isNaN(minCost) || minCost < 0) {
            await ctx.reply('Неверный формат. Пожалуйста, введите число или нажмите "Пропустить".');
            await log('w', `Invalid min cost format: "${minCostText}"`);
        } else {
            return minCost;
        }
    }
}

async function askForMaxRentCost(
    conversation: Conversation,
    ctx: Context,
    minCost: number | null,
    log: (type: LogType, message: string) => Promise<void>,
): Promise<number | null> {
    while (true) {
        await ctx.reply('💰 А теперь укажите *максимальную* цену в USD или пропустите', {
            parse_mode: 'MarkdownV2',
        });
        const maxCostCtx = await conversation.waitFor(':text');
        const maxCostText = maxCostCtx.msg.text.trim().toLowerCase();
        await log('i', `Received max cost text: "${maxCostText}"`);

        if (maxCostText === '0' || maxCostText === 'пропустить') {
            await log('i', `Max cost skipped.`);
            return null;
        }

        const maxCost = parseInt(maxCostText, 10);
        if (isNaN(maxCost) || (minCost && maxCost < minCost)) {
            await ctx.reply('Неверный формат. Пожалуйста, введите число или нажмите "Пропустить".');
            await log('w', `Invalid max cost format: "${maxCostText}"`);
        } else {
            return maxCost;
        }
    }
}

async function askForRoomCount(
    conversation: Conversation,
    ctx: Context,
    log: (type: LogType, message: string) => Promise<void>,
): Promise<Rooms[]> {
    const selectedRooms: Set<Rooms> = new Set();
    const roomsMenu = conversation.menu();
    for (const room of Object.values(Rooms)) {
        roomsMenu.text(
            () => `${selectedRooms.has(room) ? '●' : '○'} ${getRoomsDisplayName(room)}`,
            async (ctx) => {
                await log('i', `Toggling room: ${room}`);
                if (selectedRooms.has(room)) {
                    selectedRooms.delete(room);
                } else {
                    selectedRooms.add(room);
                }
                await ctx.menu.update({ immediate: true });
            }
        );
    }
    await ctx.reply('🚪 Укажите количество *комнат* \\(можно выбрать несколько\\):', {
        reply_markup: roomsMenu,
        parse_mode: 'MarkdownV2',
    });
    await ctx.reply('Для продолжения отправьте *"Готово"*', {
        reply_markup: {
            keyboard: [[{ text: 'Готово' }]],
            resize_keyboard: true,
        },
        parse_mode: 'MarkdownV2',
    });
    await conversation.waitForHears(['Готово', 'готово']);
    await log('i', `Finished room selection. Rooms: ${[...selectedRooms].join(', ')}`);
    return [...selectedRooms].sort();
}
