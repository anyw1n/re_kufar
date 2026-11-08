import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Api } = require('grammy');
process.env.BOT_TOKEN = '123:test-token';
const db = require('../lib/db.js');
const { checkNewAds } = require('../lib/parser.js');
const { City } = require('../lib/types.js');

test('new listing notifications show Studio for either representation of the Kufar code', async (context) => {
    context.mock.method(db, 'getActiveUsers', async () => [{
        chatId: 7,
        filters: { city: City.Gomel, minCost: null, maxCost: null, rooms: [] },
        lastAdTime: { toDate: () => new Date('2026-11-08T09:00:00Z') },
    }]);
    context.mock.method(db, 'updateLastAdTime', async () => {});
    const sendPhoto = context.mock.method(Api.prototype, 'sendPhoto', async () => ({ message_id: 1 }));
    const ads = [null, 2, 6, '6'].map((rooms, index) => ({
        list_time: `2026-11-08T09:0${4 - index}:00Z`,
        ad_link: 'https://example.com/ad',
        price_usd: '40000',
        images: [{ path: 'photo.jpg' }],
        account_parameters: [],
        ad_parameters: rooms === null ? [] : [{ p: 'rooms', v: rooms }],
    }));
    context.mock.method(globalThis, 'fetch', async () => Response.json({ ads }));

    await checkNewAds();

    const headings = sendPhoto.mock.calls.map((call) => call.arguments[2].caption.split('\n')[0]);
    assert.deepEqual(headings, [
        '<b>💵 400$, 🚪 Студия</b>',
        '<b>💵 400$, 🚪 Студия</b>',
        '<b>💵 400$, 🚪 2 комн.</b>',
        '<b>💵 400$</b>',
    ]);
});
