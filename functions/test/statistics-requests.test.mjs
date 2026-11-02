import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enqueueStatisticsRequest, processStatisticsRequest, StatisticsRequestStore } from '../lib/statistics-requests.js';
import { City } from '../lib/types.js';
import { FakeFirestore } from './helpers/fake-firestore.mjs';

function fixture() {
    const firestore = new FakeFirestore();
    const store = new StatisticsRequestStore(firestore);
    const loading = [];
    const removed = [];
    const edits = [];
    const loaded = [];
    const errors = [];
    const enqueueDependencies = {
        store,
        showLoading: async () => { loading.push(101); return 101; },
        removeLoading: async (messageId) => removed.push(messageId),
    };
    const processDependencies = {
        store,
        loadReport: async (city) => { loaded.push(city); return '📊 report'; },
        editMessage: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }); },
        onError: (error) => errors.push(error),
        isPermanentDeliveryError: () => false,
    };
    return { firestore, store, loading, removed, edits, loaded, errors, enqueueDependencies, processDependencies };
}

test('the webhook only persists the request; it never starts fetching the report in the background', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    assert.equal((await f.store.get('42')).status, 'queued');
    assert.deepEqual(f.loading, [101]);
    assert.deepEqual(f.loaded, []);
    assert.deepEqual(f.edits, []);

    assert.equal(await processStatisticsRequest('42', f.processDependencies), 'sent');
    assert.deepEqual(f.loaded, [City.Gomel]);
    assert.deepEqual(f.edits, [{ chatId: 1, messageId: 101, text: '📊 report' }]);
    assert.equal((await f.store.get('42')).status, 'sent');
});

test('the worker promise remains pending until the report has loaded and the message is edited', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    let resolveReport;
    f.processDependencies.loadReport = () => new Promise((resolve) => { resolveReport = resolve; });
    let finished = false;
    const processing = processStatisticsRequest('42', f.processDependencies).then((result) => {
        finished = true;
        return result;
    });
    await new Promise(setImmediate);
    assert.equal(finished, false);
    assert.equal((await f.store.get('42')).status, 'processing');
    assert.equal(f.edits.length, 0);
    resolveReport('finished report');
    assert.equal(await processing, 'sent');
    assert.equal(f.edits[0].text, 'finished report');
});

test('redelivered Telegram updates do not create another placeholder or replace the queued request', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    await enqueueStatisticsRequest('42', 1, City.Minsk, f.enqueueDependencies);
    assert.equal(f.loading.length, 1);
    assert.equal((await f.store.get('42')).city, City.Gomel);
    assert.equal(await f.store.enqueue('42', { chatId: 99, messageId: 99, city: City.Minsk }), false);
    assert.equal((await f.store.get('42')).chatId, 1);
});

test('an extra placeholder is removed if another webhook has already queued the same update', async () => {
    const f = fixture();
    f.enqueueDependencies.store.enqueue = async () => false;
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    assert.deepEqual(f.removed, [101]);
});

test('a failed queue write is propagated before the webhook can acknowledge it as complete', async () => {
    const f = fixture();
    f.firestore.failCommit = () => true;
    await assert.rejects(enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies), /simulated write failure/);
    assert.equal(await f.store.get('42'), null);
    assert.deepEqual(f.loaded, []);
});

test('a failed report updates the original loading message and records a terminal failure', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    f.processDependencies.loadReport = async () => { throw new Error('Kufar timeout'); };
    assert.equal(await processStatisticsRequest('42', f.processDependencies), 'failed');
    assert.equal((await f.store.get('42')).status, 'failed');
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].messageId, 101);
    assert.ok(f.edits[0].text.includes('Не удалось получить статистику'));
});

test('a transient edit failure resumes from the saved report without fetching Kufar again', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    const originalEdit = f.processDependencies.editMessage;
    f.processDependencies.editMessage = async () => { throw new Error('Telegram unavailable'); };
    await assert.rejects(processStatisticsRequest('42', f.processDependencies), /Telegram unavailable/);
    assert.equal((await f.store.get('42')).reportText, '📊 report');
    assert.equal((await f.store.get('42')).status, 'queued');
    f.processDependencies.editMessage = originalEdit;
    assert.equal(await processStatisticsRequest('42', f.processDependencies), 'sent');
    assert.deepEqual(f.loaded, [City.Gomel]);
    assert.equal(f.edits.length, 1);
});

test('a permanent delivery error is recorded without endless event retries', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    f.processDependencies.editMessage = async () => { throw new Error('message deleted'); };
    f.processDependencies.isPermanentDeliveryError = () => true;
    assert.equal(await processStatisticsRequest('42', f.processDependencies), 'failed');
    assert.equal((await f.store.get('42')).status, 'failed');
});

test('duplicate Firestore events skip completed, failed or missing requests', async () => {
    const f = fixture();
    assert.equal(await processStatisticsRequest('missing', f.processDependencies), 'skipped');
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    await processStatisticsRequest('42', f.processDependencies);
    assert.equal(await processStatisticsRequest('42', f.processDependencies), 'skipped');
    assert.equal(f.edits.length, 1);
    assert.equal(f.loaded.length, 1);
});

test('a live worker lease excludes another worker and fences off an expired owner', async () => {
    const f = fixture();
    await enqueueStatisticsRequest('42', 1, City.Gomel, f.enqueueDependencies);
    assert.notEqual(await f.store.claim('42', 'first'), null);
    await assert.rejects(f.store.claim('42', 'second'), /already processing/);
    f.firestore.documents.get('statisticsRequests/42').leaseExpiresAt = Date.now() - 1;
    assert.notEqual(await f.store.claim('42', 'second'), null);
    await assert.rejects(f.store.saveReport('42', 'first', 'stale report', false), /lease lost/);
    await assert.rejects(f.store.complete('42', 'first', false), /lease lost/);
    await f.store.complete('42', 'second', false);
    assert.equal((await f.store.get('42')).status, 'sent');
});
