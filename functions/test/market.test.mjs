import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    calculateMarketStatistics, DAY_MS, getTrackingCity, observeAd, summarizeEvents,
} from '../lib/market.js';
import { formatMarketStatistics, formatStatistics } from '../lib/statistics.js';
import { City } from '../lib/types.js';

const HOUR = DAY_MS / 24;
const START = Date.parse('2026-10-20T09:00:00Z');

function snapshot(hour, baseline = false) {
    return { id: `run-${hour}`, observedAt: START + hour * HOUR, baseline, adIds: [] };
}

function completed(observedAt, newAds = 0, disappearedAds = 0, returnedAds = 0, lifetimesMs = []) {
    return { observedAt, summary: { newAds, disappearedAds, returnedAds, lifetimesMs } };
}

function continueObserving(ad, firstHour, lastHour) {
    let current = ad;
    for (let hour = firstHour; hour <= lastHour; hour++) {
        current = observeAd(current, ad.adId, true, snapshot(hour)).ad;
    }
    return current;
}

test('tracking city accepts the configured city and rejects invalid settings', () => {
    assert.equal(getTrackingCity('minsk'), City.Minsk);
    assert.equal(getTrackingCity(' Gomel '), City.Gomel);
    assert.throws(() => getTrackingCity('all'), /MARKET_TRACKING_CITY/);
    assert.throws(() => getTrackingCity(''), /MARKET_TRACKING_CITY/);
});

test('tracking defaults to Minsk when the environment setting is omitted', (context) => {
    const original = process.env.MARKET_TRACKING_CITY;
    context.after(() => {
        if (original === undefined) delete process.env.MARKET_TRACKING_CITY;
        else process.env.MARKET_TRACKING_CITY = original;
    });
    delete process.env.MARKET_TRACKING_CITY;
    assert.equal(getTrackingCity(), City.Minsk);
});

test('baseline listings have an unknown lifetime start and are not counted as new', () => {
    const result = observeAd(null, 42, true, snapshot(0, true));

    assert.equal(result.event, null);
    assert.equal(result.ad.lifetimeEligible, false);
    assert.equal(result.ad.status, 'active');
    assert.equal(result.ad.firstSeenAt, START);
    assert.equal(observeAd(null, 42, false, snapshot(0, true)), null);
});

test('a first-seen ID after the baseline is counted exactly once', () => {
    const first = observeAd(null, 42, true, snapshot(1));
    const second = observeAd(first.ad, 42, true, snapshot(2));

    assert.equal(first.event.type, 'new');
    assert.equal(first.ad.lifetimeEligible, true);
    assert.equal(second.event, null);
    assert.equal(second.ad.firstSeenAt, first.ad.firstSeenAt);
    assert.equal(second.ad.lastSeenAt, START + 2 * HOUR);
});

test('one missing observation is provisional, two confirm disappearance', () => {
    const first = observeAd(null, 42, true, snapshot(1));
    const missing = observeAd(continueObserving(first.ad, 2, 24), 42, false, snapshot(25));
    const removed = observeAd(missing.ad, 42, false, snapshot(26));

    assert.equal(missing.ad.status, 'missing');
    assert.equal(missing.event, null);
    assert.equal(removed.ad.status, 'removed');
    assert.equal(removed.event.type, 'disappeared');
    assert.equal(removed.event.observedAt, START + 26 * HOUR);
    assert.equal(removed.event.lifetimeMs, DAY_MS);
    assert.equal(removed.ad.lastSeenAt, START + 24 * HOUR);
    assert.equal(observeAd(removed.ad, 42, false, snapshot(27)), null);
});

test('baseline disappearances count towards supply changes but not lifetime estimates', () => {
    const first = observeAd(null, 42, true, snapshot(0, true));
    const missing = observeAd(first.ad, 42, false, snapshot(24));
    const removed = observeAd(missing.ad, 42, false, snapshot(25));

    assert.equal(removed.event.type, 'disappeared');
    assert.equal(removed.event.lifetimeMs, null);
});

test('a temporary omission resets missing confirmations without starting another episode', () => {
    const first = observeAd(null, 42, true, snapshot(1));
    const missing = observeAd(first.ad, 42, false, snapshot(2));
    const seen = observeAd(missing.ad, 42, true, snapshot(3));
    const missingAgain = observeAd(seen.ad, 42, false, snapshot(4));

    assert.equal(seen.event, null);
    assert.equal(seen.ad.missingSnapshots, 0);
    assert.equal(seen.ad.missingSince, null);
    assert.equal(seen.ad.episodeStartedAt, first.ad.episodeStartedAt);
    assert.equal(missingAgain.ad.status, 'missing');
    assert.equal(missingAgain.event, null);
});

test('a removed ID is counted as returned and gets a new observed lifetime episode', () => {
    const first = observeAd(null, 42, true, snapshot(0, true));
    const missing = observeAd(first.ad, 42, false, snapshot(1));
    const removed = observeAd(missing.ad, 42, false, snapshot(2));
    const returned = observeAd(removed.ad, 42, true, snapshot(10));
    const missingAgain = observeAd(continueObserving(returned.ad, 11, 33), 42, false, snapshot(34));
    const removedAgain = observeAd(missingAgain.ad, 42, false, snapshot(35));

    assert.equal(returned.event.type, 'returned');
    assert.equal(returned.ad.firstSeenAt, START);
    assert.equal(returned.ad.episodeStartedAt, START + 10 * HOUR);
    assert.equal(returned.ad.lifetimeEligible, true);
    assert.equal(removedAgain.event.lifetimeMs, DAY_MS);
});

test('replaying a run cannot increment missing counts or duplicate events', () => {
    const first = observeAd(null, 42, true, snapshot(1));
    assert.equal(observeAd(first.ad, 42, true, snapshot(1)), null);
    const missing = observeAd(first.ad, 42, false, snapshot(2));
    assert.equal(observeAd(missing.ad, 42, false, snapshot(2)), null);
});

test('an episode spanning a long observation gap is excluded from lifetime estimates', () => {
    const first = observeAd(null, 42, true, snapshot(1));
    const seenAfterOutage = observeAd(first.ad, 42, true, snapshot(10));
    const missing = observeAd(seenAfterOutage.ad, 42, false, snapshot(11));
    const removed = observeAd(missing.ad, 42, false, snapshot(12));

    assert.equal(seenAfterOutage.ad.lifetimeEligible, false);
    assert.equal(removed.event.type, 'disappeared');
    assert.equal(removed.event.lifetimeMs, null);
});

test('event summaries keep returns separate and exclude unknown lifetime starts', () => {
    const summary = summarizeEvents([
        { adId: 1, type: 'new', observedAt: START, lifetimeMs: null },
        { adId: 2, type: 'returned', observedAt: START, lifetimeMs: null },
        { adId: 3, type: 'disappeared', observedAt: START, lifetimeMs: null },
        { adId: 4, type: 'disappeared', observedAt: START, lifetimeMs: 2 * DAY_MS },
    ]);
    assert.deepEqual(summary, { newAds: 1, disappearedAds: 2, returnedAds: 1, lifetimesMs: [2 * DAY_MS] });
});

test('rolling windows include their start, exclude future data and honor the published snapshot', () => {
    const now = START + 10 * DAY_MS;
    const runs = [
        completed(now - 7 * DAY_MS - 1, 100),
        completed(now - 7 * DAY_MS, 2, 1),
        completed(now - DAY_MS - 1, 3, 1),
        completed(now - DAY_MS, 4, 2, 1),
        completed(now - HOUR, 6, 3),
        completed(now, 100),
        completed(now + HOUR, 100),
    ];
    const stats = calculateMarketStatistics(runs, START, now - HOUR, now);

    assert.deepEqual(stats.day, { newAds: 10, disappearedAds: 5, returnedAds: 1, ratio: 2 });
    assert.deepEqual(stats.week, { newAds: 15, disappearedAds: 7, returnedAds: 1, ratio: 15 / 7 });
});

test('daily buckets follow Minsk midnight instead of UTC midnight', () => {
    const now = Date.parse('2026-11-02T22:00:00Z'); // 01:00 on 3 November in Minsk
    const stats = calculateMarketStatistics([
        completed(now - 2 * HOUR, 3),
        completed(now - HOUR / 2, 4, 2),
    ], START, now, now);

    assert.equal(stats.daily.length, 7);
    assert.equal(stats.daily[5].date, '2026-11-02');
    assert.equal(stats.daily[5].newAds, 3);
    assert.equal(stats.daily[6].date, '2026-11-03');
    assert.equal(stats.daily[6].newAds, 4);
    assert.equal(stats.daily[6].disappearedAds, 2);
    assert.equal(stats.daily[0].snapshots, 0);
});

test('median combines individual completed lifetimes rather than per-snapshot medians', () => {
    const now = START + 10 * DAY_MS;
    const runs = [
        completed(now - HOUR, 0, 3, 0, [DAY_MS, 2 * DAY_MS, 10 * DAY_MS]),
        completed(now, 0, 1, 0, [3 * DAY_MS]),
    ];
    const stats = calculateMarketStatistics(runs, START, now, now);
    assert.equal(stats.medianLifetimeDays, 2.5);
    assert.equal(stats.lifetimeSampleSize, 4);

    const odd = calculateMarketStatistics(runs.slice(0, 1), START, now, now);
    assert.equal(odd.medianLifetimeDays, 2);
});

test('missing removals and lifetime samples do not produce Infinity or a misleading zero median', () => {
    const now = START + HOUR;
    const stats = calculateMarketStatistics([completed(now, 5)], START, now, now);
    assert.equal(stats.day.ratio, null);
    assert.equal(stats.medianLifetimeDays, null);
    assert.equal(stats.lifetimeSampleSize, 0);
    assert.equal(stats.partialDay, true);
    assert.equal(stats.partialWeek, true);
    const text = formatMarketStatistics(stats);
    assert.ok(text.includes('исчезнувших нет'));
    assert.ok(text.includes('пока нет завершённых наблюдений'));
    assert.ok(text.includes('История за 24 часа и 7 дней пока неполная'));
    assert.ok(text.includes('нет наблюдений'));
    assert.doesNotMatch(text, /NaN|Infinity|undefined/);
});

test('zero new ads with confirmed disappearances yields a zero ratio', () => {
    const now = START + DAY_MS;
    const stats = calculateMarketStatistics([completed(now, 0, 2)], START, now, now);
    assert.equal(stats.day.ratio, 0);
});

test('history gaps and stale observations mark the reporting periods as incomplete', () => {
    const now = START + 10 * DAY_MS;
    const stats = calculateMarketStatistics([completed(now - 3 * DAY_MS)], START, now - 3 * DAY_MS, now);
    assert.equal(stats.partialDay, true);
    assert.equal(stats.partialWeek, true);
});

test('formats history, daily counts and observed lifetime with MarkdownV2 escaping', () => {
    const now = Date.parse('2026-11-02T09:00:00Z');
    const observations = Array.from({ length: 169 }, (_, index) => index === 0
        ? completed(now, 10, 4, 2, [2 * DAY_MS, 3 * DAY_MS])
        : completed(now - index * HOUR));
    const stats = calculateMarketStatistics(observations, START, now, now);
    const text = formatMarketStatistics(stats);

    assert.ok(text.includes('новых 10, исчезнувших 4'));
    assert.ok(text.includes('Новые / исчезнувшие: 2,50'));
    assert.ok(text.includes('Вернулись за 7 дней: 2'));
    assert.ok(text.includes('02\\.11: \\+10 / −4'));
    assert.ok(text.includes('\\~2,5 дн\\. \\(наблюдений: 2\\)'));
    assert.ok(text.includes('оно не подтверждает аренду'));
    assert.ok(!text.includes('История за 7 дней пока неполная'));
    assert.ok((formatStatistics([], 'Минск') + text).length < 4096);
});

test('formats the initial state without invented historical counts', () => {
    const text = formatMarketStatistics(null);
    assert.ok(text.includes('Ожидается первый успешный обход\\.'));
    assert.ok(!text.includes('новых 0'));
});
