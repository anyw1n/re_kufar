import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculatePriceStatistics, formatStatistics } from '../lib/statistics.js';

function makeAd(priceUsd, rooms = '1', companyAd = false) {
    return {
        ad_id: 1,
        ad_link: 'https://example.com/ad',
        account_parameters: [],
        ad_parameters: rooms === null ? [] : [{ p: 'rooms', v: rooms }],
        body: null,
        body_short: '',
        company_ad: companyAd,
        images: [],
        list_id: 1,
        list_time: '2026-11-02T00:00:00Z',
        price_byn: '0',
        price_usd: priceUsd,
        subject: '',
    };
}

test('calculates interpolated percentiles from unsorted prices without reordering ads', () => {
    const ads = ['50000', '10000', '40000', '20000'].map((price) => makeAd(price));
    const originalAds = [...ads];

    assert.deepEqual(calculatePriceStatistics(ads), {
        count: 4,
        min: 100,
        max: 500,
        average: 300,
        median: 300,
        p10: 130,
        p25: 175,
        p75: 425,
        p90: 470,
    });
    assert.deepEqual(ads, originalAds);
});

test('calculates an odd-sample median and percentiles at exact sample positions', () => {
    const ads = ['50000', '10000', '40000', '20000', '30000'].map((price) => makeAd(price));

    assert.deepEqual(calculatePriceStatistics(ads), {
        count: 5,
        min: 100,
        max: 500,
        average: 300,
        median: 300,
        p10: 140,
        p25: 200,
        p75: 400,
        p90: 460,
    });
});

test('keeps cents until formatting and handles a single price', () => {
    assert.deepEqual(calculatePriceStatistics([makeAd('12345')]), {
        count: 1,
        min: 123.45,
        max: 123.45,
        average: 123.45,
        median: 123.45,
        p10: 123.45,
        p25: 123.45,
        p75: 123.45,
        p90: 123.45,
    });
});

test('interpolates two prices and rounds only the formatted report', () => {
    const ads = [makeAd('10050'), makeAd('20050')];

    assert.deepEqual(calculatePriceStatistics(ads), {
        count: 2,
        min: 100.5,
        max: 200.5,
        average: 150.5,
        median: 150.5,
        p10: 110.5,
        p25: 125.5,
        p75: 175.5,
        p90: 190.5,
    });

    const text = formatStatistics(ads, 'Минск');
    assert.ok(text.includes('P25: 126$ • P50: 151$ • P75: 176$'));
    assert.ok(text.includes('P10: 111$ • P90: 191$'));
});

test('handles repeated prices', () => {
    const stats = calculatePriceStatistics(Array.from({ length: 4 }, () => makeAd('45000')));

    for (const key of ['min', 'max', 'average', 'median', 'p10', 'p25', 'p75', 'p90']) {
        assert.equal(stats[key], 450);
    }
});

test('excludes zero, negative, malformed and out-of-range prices from every price statistic', () => {
    const ads = [
        '10000', '20000', '0', '-10000', '', 'negotiable', '10000oops',
        '100.00', 'Infinity', '1e4', '1000000', '2000000', '9007199254740993',
    ].map((price) => makeAd(price));

    assert.deepEqual(calculatePriceStatistics(ads), {
        count: 2,
        min: 100,
        max: 200,
        average: 150,
        median: 150,
        p10: 110,
        p25: 125,
        p75: 175,
        p90: 190,
    });
});

test('accepts positive cents below the upper limit', () => {
    const stats = calculatePriceStatistics([makeAd('1'), makeAd('999999'), makeAd('1000000')]);

    assert.equal(stats.count, 2);
    assert.equal(stats.min, 0.01);
    assert.equal(stats.max, 9999.99);
});

test('returns no price statistics for empty or fully excluded samples', () => {
    assert.equal(calculatePriceStatistics([]), null);
    assert.equal(calculatePriceStatistics([makeAd('0'), makeAd('1000000')]), null);
});

test('formats listing counts in the city header and room-specific P50 in the price breakdown', () => {
    const ads = [
        makeAd('50000', '2', true),
        makeAd('10000'),
        makeAd('40000'),
        makeAd('20000'),
        makeAd('0', null),
    ];
    const [header, timestamp, ...sections] = formatStatistics(ads, 'Минск (тест).').split('\n');

    assert.equal(header, '📊 *Минск \\(тест\\)\\.*, 5 об\\. \\(с: 4, а: 1\\)');
    assert.match(timestamp, /^_\d{2}\\\.\d{2}\\\.\d{4}, \d{2}:\d{2}:\d{2}_$/);
    assert.deepEqual(sections, [
        '',
        '💵 *Цены \\(USD\\):*',
        '  min: 100$ • max: 500$ • av: 300$',
        '  P25: 175$ • P50: 300$ • P75: 425$',
        '  P10: 130$ • P90: 470$',
        '',
        '🚪 *По комнатам:*',
        '  1\\-комн\\.: 3 кв\\., \\~233$ • P50: 200$',
        '  2\\-комн\\.: 1 кв\\., \\~500$ • P50: 500$',
        '  Не указано: 1 кв\\., нет подходящих цен',
    ]);
});

test('formats an empty ad sample without invalid numbers', () => {
    assert.equal(formatStatistics([], 'Минск'), '📊 *Статистика*\n\nОбъявлений не найдено\\.');
});

test('keeps ad and room counts when no valid prices are available', () => {
    const text = formatStatistics([makeAd('0'), makeAd('1000000')], 'Минск');

    assert.ok(text.includes('📊 *Минск*, 2 об\\. \\(с: 2, а: 0\\)'));
    assert.ok(text.includes('Нет объявлений с подходящей ценой\\.'));
    assert.ok(text.includes('1\\-комн\\.: 2 кв\\., нет подходящих цен'));
    assert.ok(!text.includes('P50'));
    assert.doesNotMatch(text, /NaN|undefined|Infinity/);
});

test('uses only valid prices for room averages and medians while counting all studios', () => {
    const ads = ['20000', '0', '2000000', 'invalid'].map((price) => makeAd(price, '6'));
    const text = formatStatistics(ads, 'Минск');

    assert.ok(text.includes('📊 *Минск*, 4 об\\. \\(с: 4, а: 0\\)'));
    assert.ok(text.includes('Студии: 4 кв\\., \\~200$ • P50: 200$'));
});
