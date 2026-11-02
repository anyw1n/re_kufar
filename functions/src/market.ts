import { City } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
// Allow scheduling/fetch jitter around two hourly disappearance checks.
export const MAX_OBSERVATION_GAP_MS = 150 * 60 * 1000;
export const MISSING_SNAPSHOTS_TO_REMOVE = 2;

export interface TrackedAd {
    adId: number;
    firstSeenAt: number;
    lastSeenAt: number;
    episodeStartedAt: number;
    lifetimeEligible: boolean;
    missingSince: number | null;
    missingSnapshots: number;
    removedAt: number | null;
    lastRunId: string;
    status: 'active' | 'missing' | 'removed';
}

export interface MarketEvent {
    adId: number;
    type: 'new' | 'disappeared' | 'returned';
    observedAt: number;
    lifetimeMs: number | null;
}

export interface MarketSnapshot {
    id: string;
    observedAt: number;
    baseline: boolean;
    adIds: number[];
}

export interface AdChange {
    ad: TrackedAd;
    event: MarketEvent | null;
}

export interface SnapshotSummary {
    newAds: number;
    disappearedAds: number;
    returnedAds: number;
    lifetimesMs: number[];
}

export interface CompletedSnapshot {
    observedAt: number;
    summary: SnapshotSummary;
}

export interface PeriodStatistics {
    newAds: number;
    disappearedAds: number;
    returnedAds: number;
    ratio: number | null;
}

export interface DailyStatistics extends PeriodStatistics {
    date: string;
    snapshots: number;
}

export interface MarketStatistics {
    trackingStartedAt: number;
    lastSnapshotAt: number;
    partialDay: boolean;
    partialWeek: boolean;
    day: PeriodStatistics;
    week: PeriodStatistics;
    daily: DailyStatistics[];
    medianLifetimeDays: number | null;
    lifetimeSampleSize: number;
}

/** The tracked city is independent of users' notification filters. */
export function getTrackingCity(value = process.env.MARKET_TRACKING_CITY): City {
    switch (value?.trim().toLowerCase() ?? 'minsk') {
        case 'minsk': return City.Minsk;
        case 'gomel': return City.Gomel;
        default: throw new Error('MARKET_TRACKING_CITY must be minsk or gomel');
    }
}

/** Applies one complete observation; replaying the same run has no effect. */
export function observeAd(
    previous: TrackedAd | null,
    adId: number,
    seen: boolean,
    snapshot: MarketSnapshot,
): AdChange | null {
    if (previous?.lastRunId === snapshot.id) return null;

    if (!previous) {
        if (!seen) return null;
        return {
            ad: {
                adId,
                firstSeenAt: snapshot.observedAt,
                lastSeenAt: snapshot.observedAt,
                episodeStartedAt: snapshot.observedAt,
                lifetimeEligible: !snapshot.baseline,
                missingSince: null,
                missingSnapshots: 0,
                removedAt: null,
                lastRunId: snapshot.id,
                status: 'active',
            },
            event: snapshot.baseline ? null : {
                adId, type: 'new', observedAt: snapshot.observedAt, lifetimeMs: null,
            },
        };
    }

    if (seen) {
        const returned = previous.status === 'removed';
        return {
            ad: {
                ...previous,
                lastSeenAt: snapshot.observedAt,
                episodeStartedAt: returned ? snapshot.observedAt : previous.episodeStartedAt,
                lifetimeEligible: returned || (previous.lifetimeEligible &&
                    snapshot.observedAt - previous.lastSeenAt <= MAX_OBSERVATION_GAP_MS),
                missingSince: null,
                missingSnapshots: 0,
                removedAt: null,
                lastRunId: snapshot.id,
                status: 'active',
            },
            event: returned ? {
                adId, type: 'returned', observedAt: snapshot.observedAt, lifetimeMs: null,
            } : null,
        };
    }

    if (previous.status === 'removed') return null;

    const missingSnapshots = previous.missingSnapshots + 1;
    const missingSince = previous.missingSince ?? snapshot.observedAt;
    const disappeared = missingSnapshots >= MISSING_SNAPSHOTS_TO_REMOVE;
    const lifetimeEligible = previous.lifetimeEligible &&
        snapshot.observedAt - previous.lastSeenAt <= MAX_OBSERVATION_GAP_MS;
    return {
        ad: {
            ...previous,
            missingSince,
            missingSnapshots,
            lifetimeEligible,
            removedAt: disappeared ? snapshot.observedAt : null,
            lastRunId: snapshot.id,
            status: disappeared ? 'removed' : 'missing',
        },
        event: disappeared ? {
            adId,
            type: 'disappeared',
            observedAt: snapshot.observedAt,
            lifetimeMs: lifetimeEligible ? missingSince - previous.episodeStartedAt : null,
        } : null,
    };
}

export function summarizeEvents(events: readonly MarketEvent[]): SnapshotSummary {
    return {
        newAds: events.filter((event) => event.type === 'new').length,
        disappearedAds: events.filter((event) => event.type === 'disappeared').length,
        returnedAds: events.filter((event) => event.type === 'returned').length,
        lifetimesMs: events.flatMap((event) => event.lifetimeMs === null ? [] : [event.lifetimeMs]),
    };
}

const minskDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
});

function minskDate(timestamp: number): string {
    return minskDateFormatter.format(new Date(timestamp));
}

function periodStatistics(snapshots: readonly CompletedSnapshot[]): PeriodStatistics {
    const counts = snapshots.reduce((totals, snapshot) => ({
        newAds: totals.newAds + snapshot.summary.newAds,
        disappearedAds: totals.disappearedAds + snapshot.summary.disappearedAds,
        returnedAds: totals.returnedAds + snapshot.summary.returnedAds,
    }), { newAds: 0, disappearedAds: 0, returnedAds: 0 });
    return {
        ...counts,
        ratio: counts.disappearedAds === 0 ? null : counts.newAds / counts.disappearedAds,
    };
}

function incompleteCoverage(snapshots: readonly CompletedSnapshot[], start: number, end: number): boolean {
    const times = snapshots.map((snapshot) => snapshot.observedAt).sort((a, b) => a - b);
    let previous = start;
    for (const time of times) {
        if (time - previous > MAX_OBSERVATION_GAP_MS) return true;
        previous = time;
    }
    return end - previous > MAX_OBSERVATION_GAP_MS;
}

/** Windows are rolling 24 hours / 7 days; daily buckets use Europe/Minsk dates. */
export function calculateMarketStatistics(
    snapshots: readonly CompletedSnapshot[],
    trackingStartedAt: number,
    lastSnapshotAt: number,
    now: number,
): MarketStatistics {
    const weekStart = now - 7 * DAY_MS;
    const week = snapshots.filter((snapshot) =>
        snapshot.observedAt >= weekStart && snapshot.observedAt <= Math.min(now, lastSnapshotAt));
    const day = week.filter((snapshot) => snapshot.observedAt >= now - DAY_MS);
    const daily = Array.from({ length: 7 }, (_, index) => {
        const date = minskDate(now - (6 - index) * DAY_MS);
        const observations = week.filter((snapshot) => minskDate(snapshot.observedAt) === date);
        return { date, snapshots: observations.length, ...periodStatistics(observations) };
    });
    const lifetimes = week.flatMap((snapshot) => snapshot.summary.lifetimesMs).sort((a, b) => a - b);
    const middle = Math.floor(lifetimes.length / 2);
    const medianMs = lifetimes.length === 0 ? null : lifetimes.length % 2 === 1
        ? lifetimes[middle]
        : (lifetimes[middle - 1] + lifetimes[middle]) / 2;

    return {
        trackingStartedAt,
        lastSnapshotAt,
        partialDay: trackingStartedAt > now - DAY_MS || incompleteCoverage(day, now - DAY_MS, now),
        partialWeek: trackingStartedAt > weekStart || incompleteCoverage(week, weekStart, now),
        day: periodStatistics(day),
        week: periodStatistics(week),
        daily,
        medianLifetimeDays: medianMs === null ? null : medianMs / DAY_MS,
        lifetimeSampleSize: lifetimes.length,
    };
}
