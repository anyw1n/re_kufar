import { type Timestamp } from 'firebase-admin/firestore';

/**
 * Available cities for filtering real estate listings
 */
export enum City {
    Minsk = 'province-minsk~locality-minsk',
    Gomel = 'province-gomelskaja_oblast~locality-gomel',
}

export const getCityDisplayName = (city: City): string => {
    switch (city) {
        case City.Minsk:
            return 'Минск';
        case City.Gomel:
            return 'Гомель';
    };
}

/**
 * Room count options for filtering
 */
export enum Rooms {
    One = '1',
    Two = '2',
    Three = '3',
    Four = '4',
    Five = '5',
}

export const getRoomsDisplayName = (rooms: Rooms, escaping = false): string =>
    rooms === Rooms.Five ? `5${escaping ? '\\' : ''}+` : rooms;

/**
 * Filters for real estate search
 */
export interface Filters {
    /** City where the property is located */
    city: City;
    /** Minimum rent cost in USD (nullable) */
    minCost: number | null;
    /** Maximum rent cost in USD (nullable) */
    maxCost: number | null;
    /** Array of desired number of rooms (1, 2, 3, 4, or 5) */
    rooms: Rooms[];
}

/**
 * User model for storing filter settings and subscription status
 */
export interface User {
    /** Telegram chat ID */
    chatId: number;
    /** User's filter preferences */
    filters: Filters;
    /** Whether the user is subscribed to notifications */
    notificationsEnabled: boolean;
    /** Timestamp of the last ad (nullable) */
    lastAdTime: Timestamp | null;
}

/**
 * Represents a parameter for an ad or account.
 */
export interface Parameter {
    p: string;
    v: string | number | (string | number)[];
    pl: string;
    vl: string | string[];
    pu: string;
}

/**
 * Represents an image associated with an ad.
 */
export interface AdImage {
    path: string;
}

/**
 * Represents a kufar ad from the API.
 */
export interface Ad {
    ad_id: number;
    ad_link: string;
    account_parameters: Parameter[];
    ad_parameters: Parameter[];
    body: string | null;
    body_short: string;
    company_ad: boolean;
    images: AdImage[];
    list_id: number;
    list_time: string;
    price_byn: string;
    price_usd: string;
    subject: string;
}

/**
 * Represents the structure of the Kufar API response for ads.
 */
export interface KufarResponse {
    ads: Ad[];
    total: number;
    pagination: {
        pages: {
            label: string;
            num: number;
            token: string | null;
        }[];
    };
}
