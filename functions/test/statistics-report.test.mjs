import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateMarketStatistics } from '../lib/market.js';
import { renderPublicationChart } from '../lib/publication-chart.js';
import { getStatisticsReport } from '../lib/statistics-report.js';
import { City } from '../lib/types.js';

function fixture() {
    const calls = { ads: [], history: [], charts: [], errors: [], chartErrors: [] };
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
        renderChart: async (publications) => {
            calls.charts.push(publications);
            return Uint8Array.of(1, 2, 3);
        },
        onHistoryError: (error) => calls.errors.push(error),
        onChartError: (error) => calls.chartErrors.push(error),
    };
    return { source, calls };
}

test('shared report includes city prices, percentiles and history for the tracked city', async () => {
    const { source, calls } = fixture();
    const report = await getStatisticsReport(City.Gomel, source);
    assert.ok(report.text.startsWith('📊 *Гомель*, 1 об\\. \\(с: 1, а: 0\\)\n'));
    assert.ok(report.text.includes('P10: 450$'));
    assert.ok(report.text.includes('*История объявлений:*'));
    assert.ok(report.text.includes('Ожидается первый успешный обход'));
    assert.equal(report.photo, undefined);
    assert.deepEqual(calls.ads, [City.Gomel]);
    assert.deepEqual(calls.history, [City.Gomel]);
});

test('shared report attaches a dark QuickChart PNG from Minsk hourly publication counts', async () => {
    const { source } = fixture();
    const started = Date.parse('2026-11-01T00:00:00Z');
    const now = Date.parse('2026-11-07T17:00:00Z');
    const publicationTimes = [
        '2026-11-01T20:59:00Z',
        '2026-11-02T05:00:00Z',
        '2026-11-02T05:59:59Z',
        '2026-11-02T06:00:00Z',
    ].map(Date.parse);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const requests = [];
    source.loadHistory = async () => calculateMarketStatistics([], started, now, now, publicationTimes);
    source.renderChart = (publications) => renderPublicationChart(publications, async (url, options) => {
        requests.push({ url, options });
        return new Response(png);
    });
    const report = await getStatisticsReport(City.Gomel, source);

    assert.deepEqual(report.photo, png);
    assert.ok(report.text.includes('*История объявлений:*'));
    assert.doesNotMatch(report.text, /Пики с|[▁▂▃▄▅▆▇█]/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://quickchart.io/chart');
    assert.equal(requests[0].options.method, 'POST');
    assert.ok(requests[0].options.signal instanceof AbortSignal);
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.backgroundColor, '#111827');
    assert.equal(payload.devicePixelRatio, 2);
    const { data } = JSON.parse(payload.chart);
    assert.equal(data.labels.length, 24);
    assert.equal(data.labels[23], '23:00-24:00');
    assert.deepEqual(data.datasets.map((day) => day.label), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
    assert.ok(data.datasets.every((day) => day.data.length === 24 && day.cubicInterpolationMode === 'monotone'));
    assert.deepEqual(data.datasets[0].data.slice(8, 10), [2, 1]);
    assert.equal(data.datasets[6].data[23], 1);
});

test('chart errors preserve the text report and report that the graph is unavailable', async () => {
    const { source, calls } = fixture();
    const now = Date.parse('2026-11-07T17:00:00Z');
    source.loadHistory = async () => calculateMarketStatistics([], now, now, now, [now]);
    const error = new Error('QuickChart unavailable');
    source.renderChart = async () => { throw error; };
    const report = await getStatisticsReport(City.Gomel, source);

    assert.equal(report.photo, undefined);
    assert.ok(report.text.includes('P10: 450$'));
    assert.ok(report.text.includes('*История объявлений:*'));
    assert.ok(report.text.includes('График публикаций временно недоступен'));
    assert.deepEqual(calls.chartErrors, [error]);
});

test('no known publication times produces a status without requesting a chart', async () => {
    const { source, calls } = fixture();
    const now = Date.parse('2026-11-07T17:00:00Z');
    source.loadHistory = async () => calculateMarketStatistics([], now, now, now);
    const report = await getStatisticsReport(City.Gomel, source);

    assert.equal(report.photo, undefined);
    assert.ok(report.text.includes('Пока нет данных о времени публикации'));
    assert.deepEqual(calls.charts, []);
});

test('another city gets current prices without reading or collecting its history', async () => {
    const { source, calls } = fixture();
    const report = await getStatisticsReport(City.Minsk, source);
    assert.ok(report.text.startsWith('📊 *Минск*, 1 об\\. \\(с: 1, а: 0\\)\n'));
    assert.ok(report.text.includes('История собирается только для города Гомель'));
    assert.equal(report.photo, undefined);
    assert.deepEqual(calls.ads, [City.Minsk]);
    assert.deepEqual(calls.history, []);
});

test('history loading failure preserves the current price report with a clear status', async () => {
    const { source, calls } = fixture();
    const error = new Error('history unavailable');
    source.loadHistory = async () => { throw error; };
    const report = await getStatisticsReport(City.Gomel, source);
    assert.ok(report.text.includes('P90: 450$'));
    assert.ok(report.text.includes('Не удалось загрузить историю объявлений'));
    assert.deepEqual(calls.errors, [error]);
});

test('a price fetch failure rejects the report without loading unrelated history', async () => {
    const { source, calls } = fixture();
    source.fetchAds = async () => { throw new Error('Kufar unavailable'); };
    await assert.rejects(getStatisticsReport(City.Gomel, source), /Kufar unavailable/);
    assert.deepEqual(calls.history, []);
});
