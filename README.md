# ReKufar Telegram Bot

A Telegram bot for notifications about new flat ads from the Kufar.
Built with Firebase Functions, Firestore, and Grammy.

## Tech Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript
- **Backend**: Firebase Functions
- **Database**: Firestore
- **Telegram API**: Grammy
- **Deployment**: Firebase

## Project Structure

```
.
├── functions/              # Firebase Functions source code
│   ├── src/                # TypeScript source files
│   ├── lib/                # Compiled JavaScript (generated)
│   └── package.json        # Function dependencies
├── firebase.json           # Firebase configuration
├── firestore.rules         # Firestore security rules
└── firestore.indexes.json  # Firestore indexes

```

## Prerequisites

- Node.js 22 or higher
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project
- A Telegram Bot Token (obtained from [@BotFather](https://t.me/botfather))

## Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd re_kufar
   ```

2. **Install Firebase CLI** (if not already installed)

   ```bash
   npm install -g firebase-tools
   ```

3. **Login to Firebase**

   ```bash
   firebase login
   ```

4. **Install dependencies**

   ```bash
   cd functions
   npm install
   ```

5. **Configure environment variables**
   - Create two files next to `functions/package.json`:
     - `.env.local` – used when running emulators
     - `.env.prod` – used in deployed functions
   - Both files need:

   ```bash
   BOT_TOKEN=<telegram-bot-token>
   WEBHOOK_URL=https://<region>-<project>.cloudfunctions.net/tgWebhook
   ```

   `WEBHOOK_URL` should point to the deployed HTTPS function that Telegram will call. Deploying sets the webhook automatically.

6. **Deploy to Firebase**

   ```bash
   npm run deploy
   ```

## Development

### Local Development

1. **Build the TypeScript code**

   ```bash
   cd functions
   npm run build
   ```

2. **Run Firebase emulators** (for local testing)

   ```bash
   npm run serve
   ```

3. **Watch mode for development**

   ```bash
   npm run build:watch
   ```

### Available Scripts

- `npm run lint` - Run ESLint
- `npm run build` - Compile TypeScript to JavaScript
- `npm run build:watch` - Watch mode for TypeScript compilation
- `npm test` - Build and run price, lifecycle, persistence recovery, pagination, and report tests
- `npm run serve` - Start Firebase emulators
- `npm run deploy` - Deploy functions and Firestore Security Rules to Firebase
- `npm run logs` - View function logs

## Functions

- `tgWebhook` (HTTPS): Telegram webhook endpoint; sets the webhook to `WEBHOOK_URL` on cold start.
- `kufarScraper` (Scheduled): In production runs every minute to poll Kufar and push new ads. In local emulators it is exposed as `http://localhost:5001/<project-id>/us-central1/kufarScraper` for manual triggering.
- `marketTracker` (Scheduled): Runs hourly for the one city configured by
  `MARKET_TRACKING_CITY`, independently of users and notification subscriptions.
  In local emulators, trigger it manually at
  `http://localhost:5001/<project-id>/us-central1/marketTracker`.
- `dailyStatistics` (Scheduled): Sends the statistics report every day at **20:00
  Europe/Minsk** to users with notifications enabled. Change the time using
  `DAILY_STATISTICS_TIME=HH:MM`. In local emulators, trigger it manually at
  `http://localhost:5001/<project-id>/us-central1/dailyStatistics`.

## Statistics

The bot's `📊 Статистика` menu fetches all rental ads for the selected city, including
owner and agency listings, without applying the user's price or room filters.
The report includes ad counts, minimum/maximum/average/median prices, price
percentiles **P10, P25, P75, P90**, room distribution, and owner/agency counts.

Price calculations include only valid, positive USD prices below 10,000 USD. The
report shows the number of ads included in the price sample; ad and room counts
still include all listings. Room averages use only valid prices in each room group.
If no valid prices remain, the report indicates that price data is unavailable.

Percentiles use linear interpolation at index `(n - 1) * p` in the sorted price
sample, where `p` is 0.10, 0.25, 0.75, or 0.90. For example, prices of 100, 200,
400, and 500 USD yield P10 = 130, P25 = 175, P75 = 425, and P90 = 470 USD.
Calculations retain cents; displayed prices are rounded to whole dollars.

### Market history

Set `MARKET_TRACKING_CITY=minsk` in `functions/.env.prod` or `.env.local` to choose
the single city whose listings are tracked. Supported values are `minsk` and
`gomel`; omitting the setting defaults to `minsk`. Invalid values fail explicitly.
Only that city's history is collected. Users can still request current price
statistics for either city using their existing city filter.

The history section in `📊 Статистика` includes:

- New IDs and confirmed disappearances over the last **24 hours** and **7 days**.
- Daily new/disappeared counts for the last seven calendar dates in **Europe/Minsk**,
  including the current partial day. Days without successful observations say so.
- The ratio `new / disappeared` for each rolling period. With no disappearances,
  the ratio is undefined and the report states this instead of displaying infinity.
- Returned IDs as a separate count, preserving their identity instead of counting
  them as new again.
- The median observed lifetime in days for eligible episodes whose disappearance
  was confirmed in the last seven days, together with the sample size.

History begins with the first successful run after deployment. That run is a
**baseline**: existing listings are stored without being counted as new. No past
activity is reconstructed. New listings are counted when their ID is first seen,
not using Kufar's `list_time`, which may change when an ad is promoted or updated.
These counts describe observed ad IDs, not unique apartments.

A disappearance requires absence from **two consecutive complete successful
observations**. Failed requests, malformed responses, repeating cursors and
incomplete pagination do not update listing status. Duplicate IDs across pages are
deduplicated; the unique count must reach at least the largest total reported
during pagination. Truncated observations are restarted from the first page, up
to three attempts within a shared three-minute deadline; failures are discarded
without recording disappearances. Manual/retried runs
less than 30 minutes apart are skipped. Disappearances are dated at the confirming
observation and do **not** prove that an apartment was rented.

Lifetime is estimated from an episode's first observation to its first absence,
once that absence is confirmed. The hourly interval limits its precision.
Baseline listings and still-active episodes do not contribute to the median.
Episodes spanning an observation gap over 2.5 hours are excluded from lifetime
estimates; returning IDs start another episode. The median therefore describes
completed observed episodes, rather than the lifetime of all market inventory.
Reporting windows with insufficient history or long gaps are marked incomplete.

Each full ID snapshot is saved before lifecycle updates begin. A city lease
prevents overlapping collectors, and deterministic per-run events make partial
writes resumable. Only completed runs are included in reports. Interrupted runs
are resumed before fetching a newer snapshot. History is retained in Firestore
when switching the configured city; collection continues only for the selected city.

### Evening delivery

The daily report uses the same contents as the `📊 Статистика` button, prefixed with
an evening heading. Each user receives current statistics for the city in their
filters; market history remains limited to `MARKET_TRACKING_CITY`. Reports are
loaded once per requested city and shared between its recipients for that run.
No ads are fetched when there are no subscribed users.

The user's notification flag and city are checked again in a Firestore transaction
after the report is ready, immediately before reserving the delivery. Disabling
notifications stops both new-ad notifications and evening reports. Successful
deliveries are recorded per user and Minsk calendar date, so normal retries skip
already delivered reports. One user's failure does not prevent other deliveries;
the scheduled job retries failed attempts up to three times with backoff.

Delivery leases recover interrupted workers. Telegram sending and Firestore
acknowledgment are separate operations: an ambiguous Telegram timeout or a crash
after Telegram accepts a message but before the database records it can still
result in a duplicate on a later retry.

## Environment Variables

Defined in `.env.local` / `.env.prod`:

- `BOT_TOKEN` – Telegram bot token from BotFather.
- `WEBHOOK_URL` – HTTPS URL of the deployed `tgWebhook` function.
- `MARKET_TRACKING_CITY` – city for hourly market history: `minsk` (default) or `gomel`.
- `DAILY_STATISTICS_TIME` – daily report time in `Europe/Minsk`, `HH:MM` (default `20:00`).

## Data Model

- Collection `users/{chatId}`
  - `filters` – user-selected `city`, `minCost`, `maxCost`, `rooms[]`
  - `notificationsEnabled` – whether the user receives updates
  - `lastAdTime` – timestamp of the last ad sent
- Collection `marketCities/{city}`
  - `trackingStartedAt`, `lastSnapshotAt` – timestamps in milliseconds
  - `pendingRunId`, `leaseOwner`, `leaseExpiresAt` – resumable run and worker lease
  - Subcollection `ads/{adId}` – first/last observation, current visibility episode,
    lifetime eligibility, absence confirmations, and active/missing/removed status
  - Subcollection `runs/{runId}` – observation timestamp, baseline flag, completion
    status, and aggregate counts/lifetime samples for that observation
    - `pages/{page}` – complete observed ID set, stored in chunks
    - `events/{adId}` – idempotent new/disappeared/returned events
- `statisticsDeliveries/{YYYY-MM-DD}/recipients/{chatId}` – delivery status, worker
  lease, Telegram message ID, and acknowledgment timestamp for each evening report

## Firestore access

Firestore is a server-only backend for this bot. Security Rules deny direct
client reads and writes for every collection, including users and market history.
Cloud Functions use the Admin SDK and IAM, so they retain database access without
collection-specific client rules. The deploy script publishes these rules together
with the functions.

## License

MIT License - see [LICENSE](LICENSE) file for details.
