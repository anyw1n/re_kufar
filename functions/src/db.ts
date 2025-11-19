import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';

import { type Filters, type User } from './types';

initializeApp();

const db = getFirestore();
const usersCollection = db.collection('users');

/**
 * Get a user by their Telegram chat ID
 * @param chatId - Telegram chat ID
 * @returns User object or null if not found
 */
export async function getUser(chatId: number): Promise<User | null> {
    logger.info(`Getting user with chatId: ${chatId}`);
    const userDoc = await usersCollection.doc(chatId.toString()).get();

    if (!userDoc.exists) {
        logger.info(`User with chatId ${chatId} not found.`);
        return null;
    }

    const user = userDoc.data() as User;
    logger.info(`User with chatId ${chatId} found.`);
    return user;
}

/**
 * Save or update a user in the database
 * @param user - User object to save
 */
export async function saveUser(user: User): Promise<void> {
    logger.info(`Saving user with chatId: ${user.chatId}`);
    await usersCollection.doc(user.chatId.toString()).set(user);
}

/**
 * Update user filters
 * @param chatId - Telegram chat ID
 * @param filters - New filter preferences
 */
export async function updateUserFilters(chatId: number, filters: Filters): Promise<void> {
    logger.info(`Updating filters for user with chatId: ${chatId}`);
    await usersCollection.doc(chatId.toString()).update({ filters });
}

/**
 * Toggle user notifications on/off
 * @param chatId - Telegram chat ID
 * @returns New notification state (true if enabled, false if disabled)
 */
export async function toggleNotifications(chatId: number): Promise<boolean> {
    logger.info(`Toggling notifications for user with chatId: ${chatId}`);
    const userRef = usersCollection.doc(chatId.toString());
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        const errorMessage = `User with chatId ${chatId} not found`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
    }

    const currentState = (userDoc.data() as User).notificationsEnabled;
    const newState = !currentState;

    logger.info(`Updating notifications for ${chatId} from ${currentState} to ${newState}`);
    await userRef.update({
        notificationsEnabled: !currentState,
    });

    return newState;
}
