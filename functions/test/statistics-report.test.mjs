import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStatisticsReport } from '../lib/statistics-report.js';
import { City } from '../lib/types.js';

function fixture() {
    const calls = { ads: [], history: [], errors: [] };
    const source = {
        trackedCity: City.Gomel,
        fetchAds: async (city) => {
            calls.ads.push(city);
            return [{ ad_id: 1, price_usd: '45000', ad_parameters: [{ p: 'rooms', v: '1' }], company_ad: false }];
        },
        loadHistory: async (city) => {
            calls.history.push(city);
            return null;
        },
        onHistoryError: (error) => calls.errors.push(error),
    };
    return { source, calls };
}

test('shared report includes city prices, percentiles and history for the tracked city', async () => {
    const { source, calls } = fixture();
    const report = await getStatisticsReport(City.Gomel, source);
    assert.ok(report.startsWith('📊 *Гомель*, 1 объявление\n'));
    assert.ok(report.includes('P10: 450$'));
    assert.ok(report.includes('*История объявлений:*'));
    assert.ok(report.includes('Ожидается первый успешный обход'));
    assert.deepEqual(calls.ads, [City.Gomel]);
    assert.deepEqual(calls.history, [City.Gomel]);
});

test('another city gets current prices without reading or collecting its history', async () => {
    const { source, calls } = fixture();
    const report = await getStatisticsReport(City.Minsk, source);
    assert.ok(report.startsWith('📊 *Минск*, 1 объявление\n'));
    assert.ok(report.includes('История собирается только для города Гомель'));
    assert.deepEqual(calls.ads, [City.Minsk]);
    assert.deepEqual(calls.history, []);
});

test('history loading failure preserves the current price report with a clear status', async () => {
    const { source, calls } = fixture();
    const error = new Error('history unavailable');
    source.loadHistory = async () => { throw error; };
    const report = await getStatisticsReport(City.Gomel, source);
    assert.ok(report.includes('P90: 450$'));
    assert.ok(report.includes('Не удалось загрузить историю объявлений'));
    assert.deepEqual(calls.errors, [error]);
});

test('a price fetch failure rejects the report without loading unrelated history', async () => {
    const { source, calls } = fixture();
    source.fetchAds = async () => { throw new Error('Kufar unavailable'); };
    await assert.rejects(getStatisticsReport(City.Gomel, source), /Kufar unavailable/);
    assert.deepEqual(calls.history, []);
});
