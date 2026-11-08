import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliverDailyStatistics, getDailyStatisticsDate, getDailyStatisticsSchedule } from '../lib/daily-statistics.js';
import { DailyStatisticsStore } from '../lib/daily-statistics-store.js';
import { City } from '../lib/types.js';
import { FakeFirestore } from './helpers/fake-firestore.mjs';

const SCHEDULE_TIME = '2026-11-02T17:00:00Z';
const DATE = '2026-11-02';

function user(chatId, notificationsEnabled = true, city = City.Gomel) {
    return {
        chatId, notificationsEnabled, lastAdTime: null,
        filters: { city, minCost: null, maxCost: null, rooms: [] },
    };
}

function deliveryPath(chatId, date = DATE) {
    return `statisticsDeliveries/${date}/recipients/${chatId}`;
}

function fixture(users = []) {
    const firestore = new FakeFirestore();
    for (const item of users) firestore.documents.set(`users/${item.chatId}`, item);
    const repository = new DailyStatisticsStore(firestore);
    const sent = [];
    const photo = Uint8Array.of(1, 2, 3);
    const loadedCities = [];
    const errors = [];
    const dependencies = {
        repository,
        loadReport: async (city) => {
            loadedCities.push(city);
            return { text: `Statistics for ${city}`, photo: city === City.Gomel ? photo : undefined };
        },
        sendReport: async (chatId, report) => {
            sent.push({ chatId, ...report });
            return sent.length;
        },
        onError: (chatId, error) => errors.push({ chatId, error }),
    };
    return { firestore, repository, sent, loadedCities, errors, dependencies, photo };
}

test('daily statistics defaults to 20:00 and supports a configurable local time', (context) => {
    const original = process.env.DAILY_STATISTICS_TIME;
    context.after(() => {
        if (original === undefined) delete process.env.DAILY_STATISTICS_TIME;
        else process.env.DAILY_STATISTICS_TIME = original;
    });
    delete process.env.DAILY_STATISTICS_TIME;
    assert.equal(getDailyStatisticsSchedule(), '0 20 * * *');
    assert.equal(getDailyStatisticsSchedule('21:30'), '30 21 * * *');
    assert.equal(getDailyStatisticsSchedule('00:05'), '5 0 * * *');
    assert.equal(getDailyStatisticsSchedule(' 19:00 '), '0 19 * * *');
    process.env.DAILY_STATISTICS_TIME = '18:45';
    assert.equal(getDailyStatisticsSchedule(), '45 18 * * *');
});

test('invalid daily schedule values fail instead of silently using another time', () => {
    for (const value of ['', '24:00', '20:60', '8:00', '0 20 * * *', 'evening']) {
        assert.throws(() => getDailyStatisticsSchedule(value), /DAILY_STATISTICS_TIME/);
    }
});

test('delivery dates use the scheduler timestamp and Minsk calendar date', () => {
    assert.equal(getDailyStatisticsDate(SCHEDULE_TIME), DATE);
    assert.equal(getDailyStatisticsDate('2026-11-02T21:30:00Z'), '2026-11-03');
    assert.equal(getDailyStatisticsDate('2026-11-02T20:59:59Z'), DATE);
    assert.throws(() => getDailyStatisticsDate('invalid'), /Invalid daily statistics/);
});

test('no subscribers means no Kufar report loads and no Telegram sends', async () => {
    const f = fixture([user(1, false)]);
    assert.deepEqual(await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), { sent: 0, skipped: 0, failed: 0 });
    assert.deepEqual(f.loadedCities, []);
    assert.deepEqual(f.sent, []);
});

test('only subscribers receive the report for their selected city', async () => {
    const f = fixture([user(1), user(2, false), user(3, true, City.Minsk)]);
    const result = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);

    assert.equal(result.sent, 2);
    assert.deepEqual(f.sent.map((item) => item.chatId), [1, 3]);
    assert.ok(f.sent[0].text.includes(City.Gomel));
    assert.ok(f.sent[1].text.includes(City.Minsk));
    assert.ok(f.sent.every((item) => item.text.startsWith('🌆 *Вечерняя сводка*')));
    assert.equal(f.firestore.documents.has(deliveryPath(2)), false);
    assert.equal(f.firestore.documents.get(deliveryPath(1)).status, 'sent');
    assert.equal(f.firestore.documents.get(deliveryPath(1)).messageId, 1);
    assert.equal(f.firestore.documents.get('users/1').lastAdTime, null);
});

test('each requested city is loaded once per run and shared between its subscribers', async () => {
    const f = fixture([user(1), user(2), user(3, true, City.Minsk), user(4)]);
    await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    assert.deepEqual(f.loadedCities, [City.Gomel, City.Minsk]);
    assert.equal(f.sent.length, 4);
    assert.deepEqual(f.sent.map((item) => item.photo), [f.photo, f.photo, undefined, f.photo]);
});

test('turning notifications off while a report is loading prevents delivery', async () => {
    const f = fixture([user(1)]);
    f.dependencies.loadReport = async () => {
        f.firestore.documents.get('users/1').notificationsEnabled = false;
        return { text: 'report' };
    };
    const result = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    assert.equal(result.skipped, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(f.firestore.documents.has(deliveryPath(1)), false);
});

test('a changed city or deleted user cannot receive a stale report', async () => {
    for (const change of ['city', 'delete']) {
        const f = fixture([user(1)]);
        f.dependencies.loadReport = async () => {
            if (change === 'city') f.firestore.documents.get('users/1').filters.city = City.Minsk;
            else f.firestore.documents.delete('users/1');
            return { text: 'old report' };
        };
        const result = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
        assert.equal(result.skipped, 1);
        assert.equal(f.sent.length, 0);
    }
});

test('repeated delivery of the same schedule does not send another report that day', async () => {
    const f = fixture([user(1)]);
    await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    const repeated = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    assert.equal(repeated.skipped, 1);
    assert.equal(f.sent.length, 1);

    await deliverDailyStatistics('2026-11-03T17:00:00Z', f.dependencies);
    assert.equal(f.sent.length, 2);
    assert.equal(f.firestore.documents.get(deliveryPath(1, '2026-11-03')).status, 'sent');
});

test('one Telegram failure does not stop other subscribers and the retry skips successful deliveries', async () => {
    const f = fixture([user(1), user(2)]);
    const sendNormally = f.dependencies.sendReport;
    f.dependencies.sendReport = async (chatId, report) => {
        if (chatId === 1) throw new Error('temporary Telegram failure');
        return sendNormally(chatId, report);
    };
    await assert.rejects(deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), /failed for 1 users/);
    assert.deepEqual(f.sent.map((item) => item.chatId), [2]);
    assert.equal(f.firestore.documents.get(deliveryPath(1)).status, 'failed');
    assert.equal(f.firestore.documents.get(deliveryPath(2)).status, 'sent');

    f.dependencies.sendReport = sendNormally;
    const retry = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    assert.equal(retry.sent, 1);
    assert.equal(retry.skipped, 1);
    assert.deepEqual(f.sent.map((item) => item.chatId), [2, 1]);
});

test('a failed city fetch is shared within the run and does not prevent another city report', async () => {
    const f = fixture([user(1), user(2), user(3, true, City.Minsk)]);
    f.dependencies.loadReport = async (city) => {
        f.loadedCities.push(city);
        if (city === City.Gomel) throw new Error('Kufar unavailable');
        return { text: 'Minsk report' };
    };
    await assert.rejects(deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), /failed for 2 users/);
    assert.deepEqual(f.loadedCities, [City.Gomel, City.Minsk]);
    assert.deepEqual(f.sent.map((item) => item.chatId), [3]);
    assert.equal(f.firestore.documents.has(deliveryPath(1)), false);
});

test('delivery leases exclude another worker and an expired lease can be recovered', async () => {
    const f = fixture([user(1)]);
    assert.equal(await f.repository.claim(1, DATE, 'first', City.Gomel), 'claimed');
    assert.equal(await f.repository.claim(1, DATE, 'second', City.Gomel), 'busy');
    f.firestore.documents.get(deliveryPath(1)).leaseExpiresAt = Date.now() - 1;
    assert.equal(await f.repository.claim(1, DATE, 'second', City.Gomel), 'claimed');
    await assert.rejects(f.repository.markSent(1, DATE, 'first', 10), /lease lost/);
    await f.repository.markFailed(1, DATE, 'first');
    assert.equal(f.firestore.documents.get(deliveryPath(1)).owner, 'second');
    assert.equal(f.firestore.documents.get(deliveryPath(1)).status, 'sending');
    await f.repository.markSent(1, DATE, 'second', 20);
    assert.equal(await f.repository.claim(1, DATE, 'third', City.Gomel), 'skipped');
});

test('a busy delivery requests a retry instead of silently losing the report', async () => {
    const f = fixture([user(1)]);
    await f.repository.claim(1, DATE, 'other-worker', City.Gomel);
    await assert.rejects(deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), /failed for 1 users/);
    assert.equal(f.sent.length, 0);
});

test('an accepted Telegram send with a failed database acknowledgment is not immediately resent', async () => {
    const f = fixture([user(1)]);
    f.firestore.failCommit = (writes) => writes.some((write) => write.data.status === 'sent');
    await assert.rejects(deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), /failed for 1 users/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.firestore.documents.get(deliveryPath(1)).status, 'sending');
    await assert.rejects(deliverDailyStatistics(SCHEDULE_TIME, f.dependencies), /failed for 1 users/);
    assert.equal(f.sent.length, 1);
});

test('disabled recipients returned by an external repository are still ignored', async () => {
    const f = fixture();
    f.dependencies.repository.getRecipients = async () => [user(1, false)];
    const result = await deliverDailyStatistics(SCHEDULE_TIME, f.dependencies);
    assert.equal(result.skipped, 1);
    assert.equal(f.loadedCities.length, 0);
    assert.equal(f.sent.length, 0);
});
