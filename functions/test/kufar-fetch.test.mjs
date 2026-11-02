import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchAllAds } from '../lib/statistics.js';
import { City } from '../lib/types.js';

function page(ids, total, next = null) {
    return {
        ads: ids.map((ad_id) => ({ ad_id })),
        total,
        pagination: { pages: next === null ? [] : [{ label: 'next', token: next }] },
    };
}

function pagesFetcher(pages) {
    const urls = [];
    const fetcher = async (url, options) => {
        urls.push(new URL(url));
        assert.ok(options.signal instanceof AbortSignal);
        const next = pages.shift();
        if (next instanceof Error) throw next;
        assert.notEqual(next, undefined, 'unexpected extra page request');
        return next instanceof Response ? next : Response.json(next);
    };
    return { fetcher, urls };
}

function retryPages(...pages) {
    return Array.from({ length: 3 }, () => pages).flat();
}

test('fetches every page for exactly the requested city and encodes pagination tokens', async () => {
    const { fetcher, urls } = pagesFetcher([page([1, 2], 3, 'token +/='), page([3], 3)]);
    const ads = await fetchAllAds(City.Minsk, fetcher);
    assert.deepEqual(ads.map((ad) => ad.ad_id), [1, 2, 3]);
    assert.equal(urls.length, 2);
    assert.equal(urls[1].searchParams.get('cursor'), 'token +/=');
    assert.ok(urls.every((url) => url.searchParams.get('gtsy') === `country-belarus~${City.Minsk}`));
    assert.ok(urls.every((url) => url.searchParams.get('typ') === 'let'));
});

test('deduplicates IDs across pages without counting them twice', async () => {
    const { fetcher } = pagesFetcher([page([1, 2], 3, 'next'), page([2, 3], 3)]);
    const ads = await fetchAllAds(City.Gomel, fetcher);
    assert.deepEqual(ads.map((ad) => ad.ad_id), [1, 2, 3]);
});

test('a later zero total cannot make a partial fetch look like a complete shrinking market', async () => {
    const { fetcher } = pagesFetcher(retryPages(page([1, 2], 10, 'next'), page([], 0)));
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /Incomplete Kufar observation/);
});

test('rejects an incomplete observation even when pagination silently stops', async () => {
    const { fetcher, urls } = pagesFetcher(retryPages(page([1, 2], 10)));
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /Incomplete Kufar observation/);
    assert.equal(urls.length, 3);
});

test('duplicate IDs cannot make an incomplete observation look complete', async () => {
    const { fetcher } = pagesFetcher(retryPages(page([1, 2], 3, 'next'), page([1], 3)));
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /Incomplete Kufar observation/);
});

test('restarts a truncated live catalog from scratch without carrying over IDs', async () => {
    const { fetcher, urls } = pagesFetcher([
        page([1], 3), page([2, 3], 3, 'next'), page([4], 3),
    ]);
    const ads = await fetchAllAds(City.Minsk, fetcher);
    assert.deepEqual(ads.map((ad) => ad.ad_id), [2, 3, 4]);
    assert.equal(urls[1].searchParams.get('cursor'), null);
});

test('a later HTTP failure rejects the entire observation instead of returning a partial city', async () => {
    const { fetcher } = pagesFetcher([
        page([1, 2], 3, 'next'),
        ...Array.from({ length: 3 }, () => new Response('unavailable', { status: 503 })),
    ]);
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /HTTP 503/);
});

test('retries a timed-out page without fetching or accumulating earlier pages again', async () => {
    const { fetcher, urls } = pagesFetcher([
        page([1, 2], 3, 'next'), new DOMException('request timed out', 'TimeoutError'), page([3], 3),
    ]);
    const ads = await fetchAllAds(City.Gomel, fetcher);
    assert.deepEqual(ads.map((ad) => ad.ad_id), [1, 2, 3]);
    assert.equal(urls.length, 3);
    assert.equal(urls[0].searchParams.get('cursor'), null);
    assert.equal(urls[1].searchParams.get('cursor'), 'next');
    assert.equal(urls[2].searchParams.get('cursor'), 'next');
});

test('recovers from a temporary network failure and HTTP 503', async () => {
    const { fetcher } = pagesFetcher([
        new TypeError('fetch failed'), new Response('unavailable', { status: 503 }), page([1], 1),
    ]);
    assert.deepEqual((await fetchAllAds(City.Gomel, fetcher)).map((ad) => ad.ad_id), [1]);
});

test('stops after three timeouts and never returns the partial city', async () => {
    const { fetcher, urls } = pagesFetcher([
        page([1], 2, 'next'), ...Array.from({ length: 3 }, () => new DOMException('timeout', 'TimeoutError')),
    ]);
    await assert.rejects(fetchAllAds(City.Gomel, fetcher), /timeout/);
    assert.equal(urls.length, 4);
});

test('does not retry a permanent HTTP error', async () => {
    const { fetcher, urls } = pagesFetcher([new Response('bad request', { status: 400 })]);
    await assert.rejects(fetchAllAds(City.Gomel, fetcher), /HTTP 400/);
    assert.equal(urls.length, 1);
});

test('recovers from a rate-limited page', async () => {
    const { fetcher } = pagesFetcher([
        new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }), page([1], 1),
    ]);
    assert.deepEqual((await fetchAllAds(City.Gomel, fetcher)).map((ad) => ad.ad_id), [1]);
});

test('a network failure rejects the entire observation', async () => {
    const { fetcher } = pagesFetcher([page([1], 2, 'next'), new Error('network failure')]);
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /network failure/);
});

test('repeating cursors stop pagination rather than looping or confirming removals', async () => {
    const { fetcher } = pagesFetcher([page([1], 3, 'repeat'), page([2], 3, 'repeat')]);
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /repeating Kufar pagination cursor/);
});

test('an empty page with a continuation token is rejected', async () => {
    const { fetcher } = pagesFetcher([page([], 10, 'next')]);
    await assert.rejects(fetchAllAds(City.Minsk, fetcher), /pagination cursor/);
});

test('invalid response structures, totals, IDs and pagination are rejected', async () => {
    for (const data of [
        null, {}, { ads: [], total: -1 }, { ads: [], total: '0' },
        page([0], 1), page(['123'], 1), page([1, 2], 1),
        { ads: [{ ad_id: 1 }], total: 1, pagination: { pages: {} } },
    ]) {
        const { fetcher } = pagesFetcher([data]);
        await assert.rejects(fetchAllAds(City.Minsk, fetcher), /Invalid Kufar/);
    }
});

test('a complete zero-ad response is a valid observation', async () => {
    const { fetcher } = pagesFetcher([page([], 0)]);
    assert.deepEqual(await fetchAllAds(City.Minsk, fetcher), []);
});
