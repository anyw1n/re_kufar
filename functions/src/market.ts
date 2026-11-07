import { City } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const PUBLICATION_HISTORY_DAYS = 28;
export const MIN_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
// Allow scheduling/fetch jitter around two hourly disappearance checks.
export const MAX_OBSERVATION_GAP_MS = 150 * 60 * 1000;
export const MISSING_SNAPSHOTS_TO_REMOVE = 2;

export interface TrackedAd {
    adId: number;
    firstSeenAt: number;
    // Absent only on records created before list_time was collected.
    firstListTime?: number | null;
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
    // Absent in snapshots saved before publication dates were collected.
    listTimes?: Record<number, number | null>;
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

interface PublicationPeak {
    startMinute: number;
    count: number;
}

interface WeekdayPublications {
    intervals: number[];
    peaks: PublicationPeak[];
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
    publications: WeekdayPublications[];
}

/** The tracked city is independent of users' notification filters. */
export function getTrackingCity(value = process.env.MARKET_TRACKING_CITY): City {
    switch (value?.trim().toLowerCase() ?? 'minsk') {
        case 'minsk': return City.Minsk;
        case 'gomel': return City.Gomel;
        default: throw new Error('MARKET_TRACKING_CITY must be minsk or gomel');
    }
}

/** Parses a valid, non-future publication date at observation time. */
export function parseListTime(value: string | undefined, observedAt: number): number | null {
    const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= observedAt ? timestamp : null;
}

/** Start of the latest uninterrupted sequence of complete observations. */
export function continuousObservationStart(timestamps: readonly number[]): number {
    const sorted = [...timestamps].sort((a, b) => a - b);
    let start = sorted[0] ?? Infinity;
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index] - sorted[index - 1] > MAX_OBSERVATION_GAP_MS) start = sorted[index];
    }
    return start;
}

/** Applies one complete observation; replaying the same run has no effect. */
export function observeAd(
    previous: TrackedAd | null,
    adId: number,
    seen: boolean,
    snapshot: MarketSnapshot,
    continuousSince = Infinity,
): AdChange | null {
    if (previous?.lastRunId === snapshot.id) return null;

    if (!previous) {
        if (!seen) return null;
        const firstListTime = snapshot.listTimes?.[adId] ?? null;
        return {
            ad: {
                adId,
                firstSeenAt: snapshot.observedAt,
                firstListTime,
                lastSeenAt: snapshot.observedAt,
                episodeStartedAt: firstListTime ?? snapshot.observedAt,
                lifetimeEligible: firstListTime !== null || !snapshot.baseline,
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
        const listTime = snapshot.listTimes?.[adId] ?? null;
        const backfill = previous.firstListTime === undefined && listTime !== null && listTime < previous.firstSeenAt;
        const firstListTime = backfill ? listTime : previous.firstListTime ?? null;
        const backfilledFirstEpisode = backfill && previous.episodeStartedAt === previous.firstSeenAt;
        const lifetimeEligible = previous.lifetimeEligible ||
            (backfilledFirstEpisode && previous.firstSeenAt >= continuousSince);
        return {
            ad: {
                ...previous,
                firstListTime,
                lastSeenAt: snapshot.observedAt,
                episodeStartedAt: returned ? snapshot.observedAt :
                    backfilledFirstEpisode ? listTime : previous.episodeStartedAt,
                lifetimeEligible: returned || (lifetimeEligible &&
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

const minskPublicationFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Minsk', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});
const publicationWeekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const publicationStepMinutes = 15;
const publicationWindowMinutes = 120;
const publicationWindowSteps = publicationWindowMinutes / publicationStepMinutes;

function publicationPeaks(windowCounts: readonly number[]): PublicationPeak[] {
    const threshold = Math.max(...windowCounts) * 0.9;
    const candidates: PublicationPeak[] = [];
    for (let start = 0; start < windowCounts.length;) {
        const count = windowCounts[start];
        let end = start;
        while (windowCounts[end + 1] === count) end++;

        // Treat equal consecutive counts as one peak if the adjacent counts are lower.
        const hasNeighbor = start > 0 || end < windowCounts.length - 1;
        if (hasNeighbor && count >= threshold &&
            count > (windowCounts[start - 1] ?? -1) && count > (windowCounts[end + 1] ?? -1)) {
            const middle = Math.floor((start + end) / 2);
            candidates.push({ startMinute: middle * publicationStepMinutes, count });
        }
        start = end + 1;
    }

    // Keep the strongest representative of overlapping peak windows.
    const peaks: PublicationPeak[] = [];
    for (const candidate of candidates.sort((a, b) => b.count - a.count || a.startMinute - b.startMinute)) {
        if (peaks.every((peak) => Math.abs(peak.startMinute - candidate.startMinute) >= publicationWindowMinutes)) {
            peaks.push(candidate);
        }
    }
    return peaks.sort((a, b) => a.startMinute - b.startMinute);
}

function summarizePublicationDay(steps: readonly number[]): WeekdayPublications {
    let count = steps.slice(0, publicationWindowSteps).reduce((sum, value) => sum + value, 0);
    const windowCounts = [count];
    for (let next = publicationWindowSteps; next < steps.length; next++) {
        count += steps[next] - steps[next - publicationWindowSteps];
        windowCounts.push(count);
    }
    return {
        intervals: windowCounts.filter((_, start) => start % publicationWindowSteps === 0),
        peaks: publicationPeaks(windowCounts),
    };
}

function countPublications(publicationTimes: readonly number[]): WeekdayPublications[] {
    const days = publicationWeekdays.map(() => Array<number>(24 * 60 / publicationStepMinutes).fill(0));
    for (const timestamp of publicationTimes) {
        const parts = minskPublicationFormatter.formatToParts(timestamp);
        const weekday = publicationWeekdays.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? '');
        const hour = Number(parts.find((part) => part.type === 'hour')?.value);
        const minute = Number(parts.find((part) => part.type === 'minute')?.value);
        if (weekday !== -1 && Number.isFinite(hour) && Number.isFinite(minute)) {
            days[weekday][Math.floor((hour * 60 + minute) / publicationStepMinutes)]++;
        }
    }
    return days.map(summarizePublicationDay);
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
    publicationTimes: readonly number[] = [],
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
        publications: countPublications(publicationTimes),
    };
}
