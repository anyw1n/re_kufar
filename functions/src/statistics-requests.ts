import { randomUUID } from 'node:crypto';
import { type Firestore } from 'firebase-admin/firestore';

import { type StatisticsReport } from './statistics-report';
import { type City } from './types';

interface StatisticsRequestPayload {
    chatId: number;
    messageId: number;
    city: City;
}

interface StatisticsRequest extends StatisticsRequestPayload {
    status: 'queued' | 'processing' | 'sent' | 'failed';
    owner: string | null;
    leaseExpiresAt: number;
    createdAt: number;
    completedAt: number | null;
    reportText: string | null;
    reportPhoto?: Uint8Array | null;
    reportFailed: boolean;
}

export class StatisticsRequestStore {
    constructor(private readonly firestore: Firestore) {}

    private request(id: string) {
        return this.firestore.collection('statisticsRequests').doc(id);
    }

    async get(id: string): Promise<StatisticsRequest | null> {
        const doc = await this.request(id).get();
        return doc.exists ? doc.data() as StatisticsRequest : null;
    }

    async enqueue(id: string, payload: StatisticsRequestPayload): Promise<boolean> {
        const ref = this.request(id);
        return this.firestore.runTransaction(async (transaction) => {
            const existing = await transaction.get(ref);
            if (existing.exists) return false;
            const request: StatisticsRequest = {
                ...payload, status: 'queued', owner: null, leaseExpiresAt: 0,
                createdAt: Date.now(), completedAt: null, reportText: null, reportFailed: false,
            };
            transaction.set(ref, request);
            return true;
        });
    }

    async claim(id: string, owner: string): Promise<StatisticsRequest | null> {
        const ref = this.request(id);
        return this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            const request = doc.data() as StatisticsRequest | undefined;
            if (!request || request.status === 'sent' || request.status === 'failed') return null;
            if (request.status === 'processing' && request.leaseExpiresAt > Date.now()) {
                throw new Error('Statistics request is already processing');
            }
            transaction.set(ref, {
                status: 'processing', owner, leaseExpiresAt: Date.now() + 5 * 60 * 1000,
            }, { merge: true });
            return request;
        });
    }

    async saveReport(id: string, owner: string, report: StatisticsReport, reportFailed: boolean): Promise<void> {
        await this.updateOwned(id, owner, {
            reportText: report.text, reportPhoto: report.photo ?? null, reportFailed,
        });
    }

    async complete(id: string, owner: string, failed: boolean): Promise<void> {
        await this.updateOwned(id, owner, {
            status: failed ? 'failed' : 'sent', completedAt: Date.now(), leaseExpiresAt: 0, reportPhoto: null,
        });
    }

    async release(id: string, owner: string): Promise<void> {
        await this.updateOwned(id, owner, { status: 'queued', owner: null, leaseExpiresAt: 0 });
    }

    private async updateOwned(id: string, owner: string, update: Partial<StatisticsRequest>): Promise<void> {
        const ref = this.request(id);
        await this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            if (doc.data()?.owner !== owner || doc.data()?.status !== 'processing') {
                throw new Error('Statistics request lease lost');
            }
            transaction.set(ref, update, { merge: true });
        });
    }
}

interface EnqueueDependencies {
    store: StatisticsRequestStore;
    showLoading: () => Promise<number>;
    removeLoading: (messageId: number) => Promise<unknown>;
}

/** The webhook awaits only the durable queue write, never the Kufar request. */
export async function enqueueStatisticsRequest(
    id: string,
    chatId: number,
    city: City,
    dependencies: EnqueueDependencies,
): Promise<void> {
    if (await dependencies.store.get(id)) return;
    const messageId = await dependencies.showLoading();
    const created = await dependencies.store.enqueue(id, { chatId, messageId, city });
    if (!created) await dependencies.removeLoading(messageId);
}

interface ProcessDependencies {
    store: StatisticsRequestStore;
    loadReport: (city: City) => Promise<StatisticsReport>;
    editMessage: (chatId: number, messageId: number, report: StatisticsReport) => Promise<void>;
    onError: (error: unknown) => void;
    isPermanentDeliveryError: (error: unknown) => boolean;
}

/** Firestore keeps this invocation alive until the report and Telegram edit are complete. */
export async function processStatisticsRequest(id: string, dependencies: ProcessDependencies): Promise<string> {
    const owner = randomUUID();
    const request = await dependencies.store.claim(id, owner);
    if (!request) return 'skipped';

    let report: StatisticsReport | null = request.reportText === null
        ? null
        : { text: request.reportText, photo: request.reportPhoto ?? undefined };
    let failed = request.reportFailed;
    if (report === null) {
        try {
            report = await dependencies.loadReport(request.city);
        } catch (error) {
            dependencies.onError(error);
            report = { text: '❌ Не удалось получить статистику\\. Попробуйте позже\\.' };
            failed = true;
        }
        await dependencies.store.saveReport(id, owner, report, failed);
    }

    try {
        await dependencies.editMessage(request.chatId, request.messageId, report);
    } catch (error) {
        dependencies.onError(error);
        if (!dependencies.isPermanentDeliveryError(error)) {
            await dependencies.store.release(id, owner);
            throw error;
        }
        failed = true;
    }
    await dependencies.store.complete(id, owner, failed);
    return failed ? 'failed' : 'sent';
}
