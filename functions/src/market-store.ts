import { type Firestore } from 'firebase-admin/firestore';

import {
    calculateMarketStatistics,
    DAY_MS,
    MIN_SNAPSHOT_INTERVAL_MS,
    observeAd,
    summarizeEvents,
    type CompletedSnapshot,
    type MarketEvent,
    type MarketSnapshot,
    type MarketStatistics,
    type SnapshotSummary,
    type TrackedAd,
} from './market';
import { type City } from './types';

const LEASE_MS = 15 * 60 * 1000;
const PAGE_SIZE = 500;
const WRITE_CHUNK_SIZE = 150;

interface MarketCityState {
    trackingStartedAt: number | null;
    lastSnapshotAt: number | null;
    pendingRunId: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: number;
}

interface StoredRun {
    observedAt: number;
    baseline: boolean;
    pageCount: number;
    adCount: number;
    status: 'pending' | 'complete';
    summary: SnapshotSummary | null;
}

function cityState(data: Partial<MarketCityState> = {}): MarketCityState {
    return {
        trackingStartedAt: null,
        lastSnapshotAt: null,
        pendingRunId: null,
        leaseOwner: null,
        leaseExpiresAt: 0,
        ...data,
    };
}

function assertLease(state: MarketCityState, owner: string): void {
    if (state.leaseOwner !== owner || state.leaseExpiresAt <= Date.now()) {
        throw new Error('Market tracking lease lost');
    }
}

/** Publishes only complete runs and resumes partially applied runs before newer observations. */
export class MarketStore {
    constructor(private readonly firestore: Firestore) {}

    private city(city: City) {
        return this.firestore.collection('marketCities').doc(city);
    }

    async getState(city: City): Promise<MarketCityState> {
        const doc = await this.city(city).get();
        return cityState(doc.data());
    }

    async acquireLease(city: City, owner: string): Promise<boolean> {
        const ref = this.city(city);
        return this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            const state = cityState(doc.data());
            const now = Date.now();
            if (state.leaseOwner !== null && state.leaseExpiresAt > now) return false;

            transaction.set(ref, { leaseOwner: owner, leaseExpiresAt: now + LEASE_MS }, { merge: true });
            return true;
        });
    }

    async releaseLease(city: City, owner: string): Promise<void> {
        const ref = this.city(city);
        await this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            if (doc.data()?.leaseOwner === owner) {
                transaction.set(ref, { leaseOwner: null, leaseExpiresAt: 0 }, { merge: true });
            }
        });
    }

    async prepareSnapshot(city: City, owner: string, adIds: number[], observedAt: number): Promise<MarketSnapshot> {
        const cityRef = this.city(city);
        const runRef = cityRef.collection('runs').doc();
        const uniqueIds = [...new Set(adIds)];
        const pageCount = Math.max(1, Math.ceil(uniqueIds.length / PAGE_SIZE));

        // Save the entire fetched ID set before it can affect any listing's lifecycle.
        for (let offset = 0; offset < pageCount; offset += WRITE_CHUNK_SIZE) {
            const batch = this.firestore.batch();
            for (let page = offset; page < Math.min(offset + WRITE_CHUNK_SIZE, pageCount); page++) {
                batch.set(runRef.collection('pages').doc(String(page)), {
                    adIds: uniqueIds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
                });
            }
            await batch.commit();
        }

        return this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(cityRef);
            const state = cityState(doc.data());
            assertLease(state, owner);
            if (state.pendingRunId !== null) throw new Error('A market snapshot is already pending');
            if (state.lastSnapshotAt !== null && observedAt - state.lastSnapshotAt < MIN_SNAPSHOT_INTERVAL_MS) {
                throw new Error('Market observations must be at least 30 minutes apart');
            }
            const baseline = state.trackingStartedAt === null;
            const run: StoredRun = {
                observedAt, baseline, pageCount, adCount: uniqueIds.length, status: 'pending', summary: null,
            };
            transaction.set(runRef, run);
            transaction.set(cityRef, { pendingRunId: runRef.id }, { merge: true });
            return { id: runRef.id, observedAt, baseline, adIds: uniqueIds };
        });
    }

    async getPendingSnapshot(city: City): Promise<MarketSnapshot | null> {
        const state = await this.getState(city);
        if (state.pendingRunId === null) return null;

        const runRef = this.city(city).collection('runs').doc(state.pendingRunId);
        const runDoc = await runRef.get();
        const run = runDoc.data() as StoredRun | undefined;
        if (!run || run.status !== 'pending') throw new Error('Invalid pending market snapshot');

        const pages = await runRef.collection('pages').get();
        const adIds = pages.docs.flatMap((page) => page.data().adIds as number[]);
        if (pages.size !== run.pageCount || adIds.length !== run.adCount || new Set(adIds).size !== run.adCount) {
            throw new Error('Incomplete stored market snapshot');
        }
        return { id: runRef.id, observedAt: run.observedAt, baseline: run.baseline, adIds };
    }

    async applySnapshot(city: City, owner: string, snapshot: MarketSnapshot): Promise<void> {
        const cityRef = this.city(city);
        const adsRef = cityRef.collection('ads');
        const runRef = cityRef.collection('runs').doc(snapshot.id);
        const activeDocs = await adsRef.where('status', 'in', ['active', 'missing']).get();
        const records = new Map<number, TrackedAd>();
        for (const doc of activeDocs.docs) {
            const ad = doc.data() as TrackedAd;
            records.set(ad.adId, ad);
        }

        // Also load old removed IDs that have reappeared, preserving their original identity.
        const otherIds = snapshot.adIds.filter((id) => !records.has(id));
        for (let offset = 0; offset < otherIds.length; offset += PAGE_SIZE) {
            const refs = otherIds.slice(offset, offset + PAGE_SIZE).map((id) => adsRef.doc(String(id)));
            const docs = await this.firestore.getAll(...refs);
            for (const doc of docs) {
                if (!doc.exists) continue;
                const ad = doc.data() as TrackedAd;
                records.set(ad.adId, ad);
            }
        }

        const seenIds = new Set(snapshot.adIds);
        const ids = new Set([...records.keys(), ...seenIds]);
        const changes = [...ids].flatMap((id) => {
            const change = observeAd(records.get(id) ?? null, id, seenIds.has(id), snapshot);
            return change === null ? [] : [change];
        });

        for (let offset = 0; offset < changes.length; offset += WRITE_CHUNK_SIZE) {
            const chunk = changes.slice(offset, offset + WRITE_CHUNK_SIZE);
            await this.firestore.runTransaction(async (transaction) => {
                const doc = await transaction.get(cityRef);
                const state = cityState(doc.data());
                assertLease(state, owner);
                if (state.pendingRunId !== snapshot.id) throw new Error('Market snapshot changed');

                for (const change of chunk) {
                    transaction.set(adsRef.doc(String(change.ad.adId)), change.ad);
                    if (change.event !== null) {
                        transaction.set(runRef.collection('events').doc(String(change.ad.adId)), change.event);
                    }
                }
                transaction.set(cityRef, { leaseExpiresAt: Date.now() + LEASE_MS }, { merge: true });
            });
        }

        const events = await runRef.collection('events').get();
        const summary = summarizeEvents(events.docs.map((doc) => doc.data() as MarketEvent));
        await this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(cityRef);
            const state = cityState(doc.data());
            assertLease(state, owner);
            if (state.pendingRunId !== snapshot.id) throw new Error('Market snapshot changed');

            transaction.set(runRef, { status: 'complete', summary, completedAt: Date.now() }, { merge: true });
            transaction.set(cityRef, {
                trackingStartedAt: state.trackingStartedAt ?? snapshot.observedAt,
                lastSnapshotAt: snapshot.observedAt,
                pendingRunId: null,
            }, { merge: true });
        });
    }

    async getStatistics(city: City, now = Date.now()): Promise<MarketStatistics | null> {
        const state = await this.getState(city);
        if (state.trackingStartedAt === null || state.lastSnapshotAt === null) return null;

        const runs = await this.city(city).collection('runs')
            .where('observedAt', '>=', now - 7 * DAY_MS)
            .where('observedAt', '<=', Math.min(now, state.lastSnapshotAt))
            .get();
        const snapshots = runs.docs.flatMap((doc): CompletedSnapshot[] => {
            const run = doc.data() as StoredRun;
            return run.status === 'complete' && run.summary !== null
                ? [{ observedAt: run.observedAt, summary: run.summary }]
                : [];
        });
        return calculateMarketStatistics(snapshots, state.trackingStartedAt, state.lastSnapshotAt, now);
    }
}
