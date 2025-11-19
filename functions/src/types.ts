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
}
