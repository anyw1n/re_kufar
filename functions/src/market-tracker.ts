import { randomUUID } from 'node:crypto';
import * as logger from 'firebase-functions/logger';

import { db } from './db';
import { getTrackingCity, MIN_SNAPSHOT_INTERVAL_MS } from './market';
import { MarketStore } from './market-store';
import { fetchAllAds } from './statistics';

export const marketStore = new MarketStore(db);

/** Tracks just the configured city, independently of notification subscriptions. */
export async function trackMarket(): Promise<void> {
    const city = getTrackingCity();
    const owner = randomUUID();
    if (!await marketStore.acquireLease(city, owner)) {
        logger.info('[market] Another observation is already running', { city });
        return;
    }

    try {
        const pending = await marketStore.getPendingSnapshot(city);
        if (pending !== null) {
            logger.info('[market] Resuming an interrupted observation', { city, runId: pending.id });
            await marketStore.applySnapshot(city, owner, pending);
        }

        const state = await marketStore.getState(city);
        if (state.lastSnapshotAt !== null && Date.now() - state.lastSnapshotAt < MIN_SNAPSHOT_INTERVAL_MS) return;

        const ads = await fetchAllAds(city);
        const snapshot = await marketStore.prepareSnapshot(city, owner, ads, Date.now());
        await marketStore.applySnapshot(city, owner, snapshot);
        logger.info('[market] Observation complete', { city, ads: ads.length, baseline: snapshot.baseline });
    } finally {
        await marketStore.releaseLease(city, owner);
    }
}
