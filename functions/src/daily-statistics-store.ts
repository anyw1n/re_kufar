import { type Firestore } from 'firebase-admin/firestore';

import { type DailyStatisticsRepository, type DeliveryClaim } from './daily-statistics';
import { type City, type User } from './types';

const DELIVERY_LEASE_MS = 2 * 60 * 1000;

interface StatisticsDelivery {
    status: 'sending' | 'sent' | 'failed';
    owner: string;
    leaseExpiresAt: number;
    sentAt: number | null;
    messageId: number | null;
}

export class DailyStatisticsStore implements DailyStatisticsRepository {
    constructor(private readonly firestore: Firestore) {}

    private delivery(chatId: number, date: string) {
        return this.firestore.collection('statisticsDeliveries').doc(date).collection('recipients').doc(String(chatId));
    }

    async getRecipients(): Promise<User[]> {
        const users = await this.firestore.collection('users').where('notificationsEnabled', '==', true).get();
        return users.docs.map((doc) => doc.data() as User);
    }

    async claim(chatId: number, date: string, owner: string, city: City): Promise<DeliveryClaim> {
        const userRef = this.firestore.collection('users').doc(String(chatId));
        const deliveryRef = this.delivery(chatId, date);
        return this.firestore.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            const deliveryDoc = await transaction.get(deliveryRef);
            const user = userDoc.data() as User | undefined;
            const previous = deliveryDoc.data() as StatisticsDelivery | undefined;
            if (!user?.notificationsEnabled || user.filters.city !== city || previous?.status === 'sent') return 'skipped';
            if (previous?.status === 'sending' && previous.leaseExpiresAt > Date.now()) return 'busy';

            const delivery: StatisticsDelivery = {
                status: 'sending', owner, leaseExpiresAt: Date.now() + DELIVERY_LEASE_MS,
                sentAt: null, messageId: null,
            };
            transaction.set(deliveryRef, delivery);
            return 'claimed';
        });
    }

    async markSent(chatId: number, date: string, owner: string, messageId: number): Promise<void> {
        const ref = this.delivery(chatId, date);
        await this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            const delivery = doc.data() as StatisticsDelivery | undefined;
            if (delivery?.owner !== owner || delivery.status !== 'sending') throw new Error('Daily delivery lease lost');
            transaction.set(ref, { status: 'sent', sentAt: Date.now(), messageId, leaseExpiresAt: 0 }, { merge: true });
        });
    }

    async markFailed(chatId: number, date: string, owner: string): Promise<void> {
        const ref = this.delivery(chatId, date);
        await this.firestore.runTransaction(async (transaction) => {
            const doc = await transaction.get(ref);
            if (doc.data()?.owner === owner && doc.data()?.status === 'sending') {
                transaction.set(ref, { status: 'failed', leaseExpiresAt: 0 }, { merge: true });
            }
        });
    }
}
