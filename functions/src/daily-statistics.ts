import { randomUUID } from 'node:crypto';

import { type City, type User } from './types';

export type DeliveryClaim = 'claimed' | 'skipped' | 'busy';

export interface DailyStatisticsRepository {
    getRecipients(): Promise<User[]>;
    claim(chatId: number, date: string, owner: string, city: City): Promise<DeliveryClaim>;
    markSent(chatId: number, date: string, owner: string, messageId: number): Promise<void>;
    markFailed(chatId: number, date: string, owner: string): Promise<void>;
}

interface DailyStatisticsDependencies {
    repository: DailyStatisticsRepository;
    loadReport: (city: City) => Promise<string>;
    sendReport: (chatId: number, text: string) => Promise<number>;
    onError: (chatId: number, error: unknown) => void;
}

export function getDailyStatisticsSchedule(value = process.env.DAILY_STATISTICS_TIME ?? '20:00'): string {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
    if (!match) throw new Error('DAILY_STATISTICS_TIME must be HH:MM, for example 20:00');
    return `${Number(match[2])} ${Number(match[1])} * * *`;
}

export function getDailyStatisticsDate(scheduleTime: string): string {
    const date = new Date(scheduleTime);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid daily statistics schedule time');
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
}

/** Reserves each delivery after loading its report, rechecking current notification settings. */
export async function deliverDailyStatistics(scheduleTime: string, dependencies: DailyStatisticsDependencies) {
    const date = getDailyStatisticsDate(scheduleTime);
    const owner = randomUUID();
    const recipients = await dependencies.repository.getRecipients();
    const reports = new Map<City, Promise<string>>();
    const totals = { sent: 0, skipped: 0, failed: 0 };

    for (const user of recipients) {
        if (!user.notificationsEnabled) {
            totals.skipped++;
            continue;
        }
        let claimed = false;
        let accepted = false;
        try {
            const city = user.filters.city;
            let report = reports.get(city);
            if (!report) {
                report = dependencies.loadReport(city);
                reports.set(city, report);
            }
            const text = await report;
            const claim = await dependencies.repository.claim(user.chatId, date, owner, city);
            if (claim === 'skipped') {
                totals.skipped++;
                continue;
            }
            if (claim === 'busy') throw new Error('Daily report is reserved by another worker');
            claimed = true;

            const messageId = await dependencies.sendReport(user.chatId, `🌆 *Вечерняя сводка*\n\n${text}`);
            accepted = true;
            await dependencies.repository.markSent(user.chatId, date, owner, messageId);
            totals.sent++;
        } catch (error) {
            totals.failed++;
            dependencies.onError(user.chatId, error);
            if (claimed && !accepted) {
                try {
                    await dependencies.repository.markFailed(user.chatId, date, owner);
                } catch (releaseError) {
                    dependencies.onError(user.chatId, releaseError);
                }
            }
        }
    }

    if (totals.failed > 0) throw new Error(`Daily statistics delivery failed for ${totals.failed} users`);
    return totals;
}
