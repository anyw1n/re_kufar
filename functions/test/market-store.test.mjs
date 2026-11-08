import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DAY_MS, PUBLICATION_HISTORY_DAYS } from '../lib/market.js';
import { MarketStore } from '../lib/market-store.js';
import { City } from '../lib/types.js';
import { FakeFirestore } from './helpers/fake-firestore.mjs';

const START = Date.parse('2026-10-20T09:00:00Z');
const HOUR = DAY_MS / 24;
const CITY_PATH = `marketCities/${City.Minsk}`;

function ads(ids, listTimes = {}) {
    return ids.map((id) => ({ ad_id: id, list_time: listTimes[id] ?? '' }));
}

async function fixture(ids = [], listTimes = {}) {
    const firestore = new FakeFirestore();
    const store = new MarketStore(firestore);
    assert.equal(await store.acquireLease(City.Minsk, 'worker-1'), true);
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', ads(ids, listTimes), START);
    await store.applySnapshot(City.Minsk, 'worker-1', snapshot);
    return { firestore, store };
}

test('publishes a baseline without treating existing listings as new', async () => {
    const { firestore, store } = await fixture([1, 2]);
    const stats = await store.getStatistics(City.Minsk, START);

    assert.equal(stats.week.newAds, 0);
    assert.equal(stats.week.disappearedAds, 0);
    assert.equal(stats.trackingStartedAt, START);
    assert.equal((await store.getState(City.Minsk)).pendingRunId, null);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).lifetimeEligible, false);
    assert.equal(await store.getStatistics(City.Gomel, START), null);
    assert.ok(![...firestore.documents.keys()].some((path) => path.includes(City.Gomel)));
});

test('a live lease excludes another worker and cannot be released by that worker', async () => {
    const { store } = await fixture();
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), false);
    await store.releaseLease(City.Minsk, 'worker-2');
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), false);
    await store.releaseLease(City.Minsk, 'worker-1');
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), true);
});

test('an expired lease is recoverable and the previous owner cannot write', async () => {
    const { firestore, store } = await fixture();
    firestore.documents.get(CITY_PATH).leaseExpiresAt = Date.now() - 1;
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), true);
    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', ads([1]), START + HOUR), /lease lost/);
});

test('snapshots less than 30 minutes apart cannot confirm a disappearance twice', async () => {
    const { store } = await fixture([1]);
    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', [], START + 60_000), /30 minutes/);
    assert.equal((await store.getState(City.Minsk)).pendingRunId, null);
});

test('failure while saving snapshot pages cannot modify lifecycles or publish a pending run', async () => {
    const { firestore, store } = await fixture([1]);
    const original = structuredClone(firestore.documents.get(`${CITY_PATH}/ads/1`));
    firestore.failCommit = (writes) => writes.some((write) => write.ref.path.includes('/pages/'));

    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', [], START + HOUR), /simulated write failure/);
    assert.deepEqual(firestore.documents.get(`${CITY_PATH}/ads/1`), original);
    assert.equal((await store.getState(City.Minsk)).pendingRunId, null);
    assert.equal((await store.getStatistics(City.Minsk, START + HOUR)).week.disappearedAds, 0);
});

test('resumes a failure between write chunks without dropping or duplicating new events', async () => {
    const { firestore, store } = await fixture();
    const ids = Array.from({ length: 300 }, (_, index) => index + 1);
    const publishedAt = START;
    const listTimes = Object.fromEntries(ids.map((id) => [id, new Date(publishedAt).toISOString()]));
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', ads(ids, listTimes), START + HOUR);
    firestore.failCommit = (writes) => writes.some((write) => write.ref.path === `${CITY_PATH}/ads/151`);

    await assert.rejects(store.applySnapshot(City.Minsk, 'worker-1', snapshot), /simulated write failure/);
    const incomplete = await store.getStatistics(City.Minsk, START + HOUR);
    assert.equal(incomplete.week.newAds, 0);
    assert.equal(incomplete.publications[1][12], 0);
    assert.equal((await store.getState(City.Minsk)).lastSnapshotAt, START);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).lastRunId, snapshot.id);
    assert.equal(firestore.documents.has(`${CITY_PATH}/ads/151`), false);
    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', ads([999]), START + 2 * HOUR), /already pending/);

    await store.releaseLease(City.Minsk, 'worker-1');
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), true);
    const pending = await store.getPendingSnapshot(City.Minsk);
    assert.equal(pending.id, snapshot.id);
    assert.equal(pending.observedAt, snapshot.observedAt);
    assert.deepEqual(pending.adIds, ids);
    assert.deepEqual(pending.listTimes, Object.fromEntries(ids.map((id) => [id, publishedAt])));
    await store.applySnapshot(City.Minsk, 'worker-2', pending);

    const stats = await store.getStatistics(City.Minsk, START + HOUR);
    assert.equal(stats.week.newAds, 300);
    assert.equal(stats.publications[1][12], 300);
    assert.equal(stats.week.disappearedAds, 0);
    assert.equal((await store.getState(City.Minsk)).pendingRunId, null);
    assert.equal(await store.getPendingSnapshot(City.Minsk), null);
    assert.ok(ids.every((id) => firestore.documents.get(`${CITY_PATH}/ads/${id}`).firstListTime === publishedAt));
    assert.ok(firestore.commits.every((writes) => writes.length <= 500));
});

test('publication history uses the first saved date for disappeared ads until it leaves the window', async () => {
    const { firestore, store } = await fixture();
    const publishedAt = START + HOUR;
    const seenAt = publishedAt + DAY_MS;
    const first = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([42, 43], { 42: new Date(publishedAt).toISOString() }), seenAt);
    await store.applySnapshot(City.Minsk, 'worker-1', first);
    const promoted = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([42], { 42: new Date(seenAt).toISOString() }), seenAt + HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', promoted);
    const missing = await store.prepareSnapshot(City.Minsk, 'worker-1', [], seenAt + 2 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', missing);
    const removed = await store.prepareSnapshot(City.Minsk, 'worker-1', [], seenAt + 3 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', removed);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/42`).status, 'removed');

    const boundary = publishedAt + PUBLICATION_HISTORY_DAYS * DAY_MS;
    const current = await store.getStatistics(City.Minsk, boundary);
    assert.equal(current.publications[1][13], 1); // Tuesday 13:00 in Minsk
    assert.deepEqual(current.publications.flat().filter(Boolean), [1]);
    const expired = await store.getStatistics(City.Minsk, boundary + 1);
    assert.ok(expired.publications.every((day) => day.every((count) => count === 0)));
});

test('failure just before publication preserves confirmed disappearance events on resume', async () => {
    const { firestore, store } = await fixture();
    const appeared = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([42]), START + HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', appeared);
    for (let hour = 2; hour <= 24; hour++) {
        const seen = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([42]), START + hour * HOUR);
        await store.applySnapshot(City.Minsk, 'worker-1', seen);
    }
    const missing = await store.prepareSnapshot(City.Minsk, 'worker-1', [], START + 25 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', missing);
    const removed = await store.prepareSnapshot(City.Minsk, 'worker-1', [], START + 26 * HOUR);
    firestore.failCommit = (writes) => writes.some((write) => write.data.status === 'complete');

    await assert.rejects(store.applySnapshot(City.Minsk, 'worker-1', removed), /simulated write failure/);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/42`).status, 'removed');
    assert.equal((await store.getStatistics(City.Minsk, START + 26 * HOUR)).week.disappearedAds, 0);

    const pending = await store.getPendingSnapshot(City.Minsk);
    await store.applySnapshot(City.Minsk, 'worker-1', pending);
    const stats = await store.getStatistics(City.Minsk, START + 26 * HOUR);
    assert.equal(stats.week.disappearedAds, 1);
    assert.equal(stats.medianLifetimeDays, 1);
    assert.equal(stats.lifetimeSampleSize, 1);
});

test('an incomplete persisted snapshot cannot be resumed as a complete city observation', async () => {
    const { firestore, store } = await fixture([1]);
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([2]), START + HOUR);
    firestore.documents.delete(`${CITY_PATH}/runs/${snapshot.id}/pages/0`);

    await assert.rejects(store.getPendingSnapshot(City.Minsk), /Incomplete stored market snapshot/);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).status, 'active');
});

test('the same ID returning after confirmation does not become another new ad', async () => {
    const { firestore, store } = await fixture([42]);
    for (const hour of [1, 2]) {
        const missing = await store.prepareSnapshot(City.Minsk, 'worker-1', [], START + hour * HOUR);
        await store.applySnapshot(City.Minsk, 'worker-1', missing);
    }
    const returned = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([42]), START + 3 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', returned);

    const stats = await store.getStatistics(City.Minsk, START + 3 * HOUR);
    assert.equal(stats.week.newAds, 0);
    assert.equal(stats.week.returnedAds, 1);
    assert.equal(stats.week.disappearedAds, 1);
    assert.equal(stats.lifetimeSampleSize, 0);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/42`).firstSeenAt, START);
});

test('publication dates survive persistence, promotion and confirmed disappearance', async () => {
    const publishedAt = START - DAY_MS;
    const { firestore, store } = await fixture([42], { 42: new Date(publishedAt).toISOString() });
    const promoted = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([42], { 42: new Date(START + HOUR).toISOString() }), START + HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', promoted);
    for (const hour of [2, 3]) {
        const missing = await store.prepareSnapshot(City.Minsk, 'worker-1', [], START + hour * HOUR);
        await store.applySnapshot(City.Minsk, 'worker-1', missing);
    }

    const record = firestore.documents.get(`${CITY_PATH}/ads/42`);
    const stats = await store.getStatistics(City.Minsk, START + 3 * HOUR);
    assert.equal(record.firstListTime, publishedAt);
    assert.equal(record.firstSeenAt, START);
    assert.equal(stats.week.newAds, 0);
    assert.equal(stats.week.disappearedAds, 1);
    assert.equal(stats.lifetimeSampleSize, 1);
    assert.equal(stats.medianLifetimeDays, (DAY_MS + 2 * HOUR) / DAY_MS);
});

test('legacy baseline dates earlier than firstSeenAt are filled once and contribute to future lifetimes', async () => {
    const { firestore, store } = await fixture([1, 2, 3]);
    for (const id of [1, 2, 3]) delete firestore.documents.get(`${CITY_PATH}/ads/${id}`).firstListTime;
    const times = {
        1: new Date(START - DAY_MS).toISOString(),
        2: new Date(START).toISOString(),
        3: new Date(START + HOUR / 2).toISOString(),
    };
    const observed = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([1, 2, 3], times), START + HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', await store.getPendingSnapshot(City.Minsk));

    const record = firestore.documents.get(`${CITY_PATH}/ads/1`);
    assert.equal(record.firstListTime, START - DAY_MS);
    assert.equal(record.firstSeenAt, START);
    assert.equal(record.episodeStartedAt, START - DAY_MS);
    assert.equal(record.lifetimeEligible, true);
    for (const id of [2, 3]) {
        const unchanged = firestore.documents.get(`${CITY_PATH}/ads/${id}`);
        assert.equal(unchanged.firstListTime, null);
        assert.equal(unchanged.episodeStartedAt, START);
        assert.equal(unchanged.lifetimeEligible, false);
    }
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).lastRunId, observed.id);

    const promoted = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([1, 2, 3], { 1: new Date(START + 2 * HOUR).toISOString() }), START + 2 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', promoted);
    for (const hour of [3, 4]) {
        const missing = await store.prepareSnapshot(City.Minsk, 'worker-1', [], START + hour * HOUR);
        await store.applySnapshot(City.Minsk, 'worker-1', missing);
    }
    const stats = await store.getStatistics(City.Minsk, START + 4 * HOUR);
    assert.equal(stats.week.newAds, 0);
    assert.equal(stats.lifetimeSampleSize, 1);
    assert.equal(stats.medianLifetimeDays, (DAY_MS + 3 * HOUR) / DAY_MS);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).firstListTime, START - DAY_MS);
});

test('filling a legacy date cannot reinstate a lifetime excluded by an earlier observation gap', async () => {
    const { firestore, store } = await fixture([42]);
    const afterGap = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([42]), START + 10 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', afterGap);
    delete firestore.documents.get(`${CITY_PATH}/ads/42`).firstListTime;
    const backfill = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([42], { 42: new Date(START - DAY_MS).toISOString() }), START + 11 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', backfill);

    const record = firestore.documents.get(`${CITY_PATH}/ads/42`);
    assert.equal(record.firstListTime, START - DAY_MS);
    assert.equal(record.episodeStartedAt, START - DAY_MS);
    assert.equal(record.lifetimeEligible, false);
});

test('legacy pending pages and listing records remain resumable without publication dates', async () => {
    const { firestore, store } = await fixture([1]);
    delete firestore.documents.get(`${CITY_PATH}/ads/1`).firstListTime;
    const pending = await store.prepareSnapshot(City.Minsk, 'worker-1', ads([1, 2]), START + HOUR);
    delete firestore.documents.get(`${CITY_PATH}/runs/${pending.id}`).listTimesStored;
    delete firestore.documents.get(`${CITY_PATH}/runs/${pending.id}/pages/0`).listTimes;

    const restored = await store.getPendingSnapshot(City.Minsk);
    assert.deepEqual(restored.listTimes, {});
    await store.applySnapshot(City.Minsk, 'worker-1', restored);
    const baseline = firestore.documents.get(`${CITY_PATH}/ads/1`);
    const added = firestore.documents.get(`${CITY_PATH}/ads/2`);
    assert.equal(baseline.firstListTime, null);
    assert.equal(baseline.episodeStartedAt, START);
    assert.equal(baseline.lifetimeEligible, false);
    assert.equal(added.firstListTime, null);
    assert.equal(added.episodeStartedAt, START + HOUR);
    assert.equal(added.lifetimeEligible, true);
});

test('a new pending snapshot with missing publication metadata cannot silently change its lifetime basis', async () => {
    const { firestore, store } = await fixture();
    const pending = await store.prepareSnapshot(City.Minsk, 'worker-1',
        ads([42], { 42: new Date(START).toISOString() }), START + HOUR);
    delete firestore.documents.get(`${CITY_PATH}/runs/${pending.id}/pages/0`).listTimes[42];

    await assert.rejects(store.getPendingSnapshot(City.Minsk), /Incomplete stored market publication dates/);
    assert.equal(firestore.documents.has(`${CITY_PATH}/ads/42`), false);
});

test('publication dates are restored across multiple snapshot pages', async () => {
    const { store } = await fixture();
    const ids = Array.from({ length: 501 }, (_, index) => index + 1);
    const listTimes = Object.fromEntries(ids.map((id) => [id, new Date(START - id * HOUR).toISOString()]));
    const pending = await store.prepareSnapshot(City.Minsk, 'worker-1', ads(ids, listTimes), START + HOUR);

    assert.deepEqual(await store.getPendingSnapshot(City.Minsk), pending);
});
