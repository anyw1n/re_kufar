import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DAY_MS } from '../lib/market.js';
import { MarketStore } from '../lib/market-store.js';
import { City } from '../lib/types.js';
import { FakeFirestore } from './helpers/fake-firestore.mjs';

const START = Date.parse('2026-10-20T09:00:00Z');
const HOUR = DAY_MS / 24;
const CITY_PATH = `marketCities/${City.Minsk}`;

async function fixture(ids = []) {
    const firestore = new FakeFirestore();
    const store = new MarketStore(firestore);
    assert.equal(await store.acquireLease(City.Minsk, 'worker-1'), true);
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', ids, START);
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
    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', [1], START + HOUR), /lease lost/);
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
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', ids, START + HOUR);
    firestore.failCommit = (writes) => writes.some((write) => write.ref.path === `${CITY_PATH}/ads/151`);

    await assert.rejects(store.applySnapshot(City.Minsk, 'worker-1', snapshot), /simulated write failure/);
    assert.equal((await store.getStatistics(City.Minsk, START + HOUR)).week.newAds, 0);
    assert.equal((await store.getState(City.Minsk)).lastSnapshotAt, START);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/1`).lastRunId, snapshot.id);
    assert.equal(firestore.documents.has(`${CITY_PATH}/ads/151`), false);
    await assert.rejects(store.prepareSnapshot(City.Minsk, 'worker-1', [999], START + 2 * HOUR), /already pending/);

    await store.releaseLease(City.Minsk, 'worker-1');
    assert.equal(await store.acquireLease(City.Minsk, 'worker-2'), true);
    const pending = await store.getPendingSnapshot(City.Minsk);
    assert.equal(pending.id, snapshot.id);
    assert.equal(pending.observedAt, snapshot.observedAt);
    assert.deepEqual(pending.adIds, ids);
    await store.applySnapshot(City.Minsk, 'worker-2', pending);

    const stats = await store.getStatistics(City.Minsk, START + HOUR);
    assert.equal(stats.week.newAds, 300);
    assert.equal(stats.week.disappearedAds, 0);
    assert.equal((await store.getState(City.Minsk)).pendingRunId, null);
    assert.equal(await store.getPendingSnapshot(City.Minsk), null);
    assert.ok(firestore.commits.every((writes) => writes.length <= 500));
});

test('failure just before publication preserves confirmed disappearance events on resume', async () => {
    const { firestore, store } = await fixture();
    const appeared = await store.prepareSnapshot(City.Minsk, 'worker-1', [42], START + HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', appeared);
    for (let hour = 2; hour <= 24; hour++) {
        const seen = await store.prepareSnapshot(City.Minsk, 'worker-1', [42], START + hour * HOUR);
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
    const snapshot = await store.prepareSnapshot(City.Minsk, 'worker-1', [2], START + HOUR);
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
    const returned = await store.prepareSnapshot(City.Minsk, 'worker-1', [42], START + 3 * HOUR);
    await store.applySnapshot(City.Minsk, 'worker-1', returned);

    const stats = await store.getStatistics(City.Minsk, START + 3 * HOUR);
    assert.equal(stats.week.newAds, 0);
    assert.equal(stats.week.returnedAds, 1);
    assert.equal(stats.week.disappearedAds, 1);
    assert.equal(stats.lifetimeSampleSize, 0);
    assert.equal(firestore.documents.get(`${CITY_PATH}/ads/42`).firstSeenAt, START);
});
