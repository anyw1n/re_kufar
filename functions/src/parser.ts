import { logger } from 'firebase-functions';

import { InlineKeyboard } from 'grammy';

import { sendPhoto } from './bot';
import * as db from './db';
import { type Filters, type KufarResponse } from './types';

const makeKfRequestUrl = (filters: Filters): string => {
    const { city, minCost, maxCost, rooms } = filters;
    return 'https://api.kufar.by/search-api/v2/search/rendered-paginated' + // base
        '?cat=1010' + // category
        `&cmp=0` + // not an agency
        `&cur=USD` + // currency
        `&gtsy=country-belarus~${city}` + // city
        `&lang=ru` + // language
        `&oph=1` + // with photos
        (minCost !== null || maxCost !== null ? `&prc=r%3A${minCost ?? 0}%2C${maxCost ?? 1000000000}` : '') + // price
        (rooms.length > 0 ? `&rms=v.or%3A${rooms.join('%2C')}` : '') + // rooms
        `&size=30` + // page size
        `&typ=let`; // rent type
}

export async function checkNewAds() {
    logger.info('Starting kufarScraper job');
    try {
        const users = await db.getActiveUsers();
        if (users.length === 0) {
            logger.info('No active users found, skipping run.');
            return;
        }
        logger.info(`Found ${users.length} active users.`);

        const grouped = Object.groupBy(users, ({ filters }) => makeKfRequestUrl(filters));
        logger.info(`Grouped users into ${Object.keys(grouped).length} distinct Kufar requests.`);

        for (const [url, usersInGroup] of Object.entries(grouped)) {
            if (!usersInGroup) continue;
            logger.info(`Fetching ads from ${url} for ${usersInGroup.length} users.`);
            const response = await fetch(url);
            const { ads } = await response.json() as KufarResponse;
            logger.info(`Received ${ads.length} ads from ${url}.`);
            await db.updateLastAdTime(usersInGroup.map(({ chatId }) => chatId), new Date(ads[0].list_time));
            const users = usersInGroup.filter(({ lastAdTime }) => lastAdTime);
            if (users.length === 0) {
                logger.info(`Users for ${url} has no lastAdTime date, skipping.`);
                continue;
            }
            const lastAdTimeDate = users[0].lastAdTime!.toDate();
            const newAds = ads.filter((ad) => new Date(ad.list_time) > lastAdTimeDate);
            if (newAds.length === 0) {
                logger.info(`Not found new ads for ${url}. Skipping.`);
                continue;
            }
            logger.info(`Found ${newAds.length} new ads. Sending notifications.`);
            for (const ad of newAds.reverse()) {
                const image = 'https://rms.kufar.by/v1/gallery/' + ad.images[0].path;
                const address = ad
                    .account_parameters
                    .find((e) => e.p === 'address')
                    ?.v;
                const price = ad.price_usd.slice(0, -2);
                const rooms = ad.ad_parameters.find((e) => e.p === 'rooms')?.v;
                const date = new Date(ad.list_time).toLocaleString('ru-BY', { timeZone: 'Europe/Minsk' });
                const adUrl = ad.ad_link;
                for (const { chatId } of users) {
                    await sendPhoto(chatId, image, {
                        caption: `<b>💵 ${price}$${rooms ? `, 🚪 ${rooms} комн.` : ''}</b>\n` +
                            `📍 ${address ?? 'Адрес не указан'}\n\n` +
                            `<i>📆 ${date}</i>`,
                        parse_mode: 'HTML',
                        reply_markup: new InlineKeyboard()
                            .url('Перейти к объявлению', adUrl),
                    });
                }
            }
        }
        logger.info('Kufar scraper job finished successfully.');
    } catch (error) {
        logger.error('An error occurred in kufarScraper job', error);
    }
}
