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

   `WEBHOOK_URL` should point to the deployed HTTPS function that Telegram will call.
   The deploy script registers it after deployment; run `npm run register-webhook`
   separately when deploying through the Firebase CLI directly.

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
- `npm run register-webhook` - Register the Telegram webhook once after deployment
- `npm run logs` - View function logs

## Functions

- `tgWebhook` (HTTPS): Telegram webhook endpoint. Registration is performed after
  deployment rather than on every function's cold start.
- `statisticsRequestWorker` (Firestore): Processes `statisticsRequests/{requestId}`
  created by the statistics button and updates its loading message with the report.
  The webhook returns after the request has been queued; the worker awaits all
  fetching and Telegram API calls before its invocation completes.
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
The report includes ad counts, minimum/maximum/average prices, price percentiles
**P10, P25, P50, P75, P90**, room distribution, and owner/agency counts.

Price calculations include only valid, positive USD prices below 10,000 USD.
Room averages and medians use valid prices within each room group. Ad and room
counts include all listings. If no valid prices remain, the report indicates
that price data is unavailable.

Percentiles use linear interpolation at index `(n - 1) * p` in the sorted price
sample, where `p` is 0.10, 0.25, 0.50, 0.75, or 0.90. For example, prices of 100,
200, 400, and 500 USD yield P10 = 130, P25 = 175, P50 = 300, P75 = 425, and P90 = 470 USD.
Calculations retain cents; displayed prices are rounded to whole dollars.

Manual requests run in a durable Firestore queue so their network operations do
not depend on CPU availability after the Telegram webhook has returned. Requests
are deduplicated by Telegram update ID. The rendered report is saved before
editing the original loading message, allowing delivery retries without refetching.

### Market history

Set `MARKET_TRACKING_CITY=minsk` in `functions/.env.prod` or `.env.local` to choose
the single city whose listings are tracked. Supported values are `minsk` and
`gomel`; omitting the setting defaults to `minsk`. Invalid values fail explicitly.
Only that city's history is collected. Users can still request current price
statistics for either city using their existing city filter.

The history section in `📊 Статистика` includes:

- New IDs and confirmed disappearances over the last **24 hours** and **7 days**.
- Daily new/disappeared counts for the last seven calendar dates in **Europe/Minsk**,
  including the current partial day, shown two dates per line. `н/н` marks days
  without successful observations.
- The ratio `new / disappeared` for each rolling period. A dash indicates an
  undefined ratio when there are no disappearances.
- Returned IDs as a separate count, preserving their identity instead of counting
  them as new again.
- The median estimated lifetime in days for eligible episodes whose disappearance
  was confirmed in the last seven days, labeled `Среднее время жизни`.
- A weekday publication histogram using saved first publication times within
  the last **28 days** of tracked history. Each bar represents two hours in
  Minsk time and scales to the busiest bar of that weekday. Peak labels show
  the starts of non-overlapping two-hour windows and their shares of that
  weekday's publications. Windows advance by 15 minutes, with distinct peaks
  shown when they reach at least 90% of the busiest window.

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

Individual page requests also retry timeouts, connection failures, HTTP 408/429
and server errors up to three times, within the same overall deadline. Successful
earlier pages are retained during page retries. Permanent HTTP errors and invalid
response structures fail without updating listing status.

For a newly tracked ID, the valid `list_time` from its first observation is saved
as `firstListTime` and never overwritten by subsequent updates or promotions. Its first lifetime is
estimated from that date to its first absence, once the absence is confirmed.
`firstSeenAt` separately records when the tracker first encountered the ID; new
listing counts continue to use that observation. Missing, invalid, or future
publication dates fall back to the first observation, with baseline listings
without a valid date excluded from lifetime estimates. Dates already changed by
promotions before the first observation cannot be reconstructed, so this remains
an estimate of publication-to-disappearance time.

Legacy records without `firstListTime` are filled on their next appearance only
when the current valid `list_time` is strictly earlier than their `firstSeenAt`.
For their first episode this earlier date becomes the lifetime start. Previously
excluded baseline episodes become eligible only when stored completed runs prove
continuous observation since `firstSeenAt`; earlier gaps remain excluded. Already
completed historical events and summaries are not recalculated.

The hourly interval limits disappearance precision. Still-active episodes do not
contribute to the median.
Episodes spanning an observation gap over 2.5 hours are excluded from lifetime
estimates; returning IDs retain `firstListTime` and start another episode at their
return observation, keeping time spent absent out of the new lifetime. The median
therefore describes completed tracked episodes, rather than the lifetime of all
market inventory.
Reporting windows with insufficient history or long gaps are marked incomplete.

Each full ID snapshot and its fetched publication dates are saved before lifecycle
updates begin. A city lease prevents overlapping collectors, and deterministic
per-run events make partial writes resumable. Only completed runs are included in
reports. Interrupted runs are resumed before fetching a newer snapshot. History is retained in Firestore
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
  - Subcollection `ads/{adId}` – first/last observation, immutable `firstListTime`,
    current visibility episode, lifetime eligibility, absence confirmations, and
    active/missing/removed status
  - Subcollection `runs/{runId}` – observation timestamp, baseline flag, completion
    status, and aggregate counts/lifetime samples for that observation
    - `pages/{page}` – complete observed ID set and publication dates, stored in chunks
    - `events/{adId}` – idempotent new/disappeared/returned events
- `statisticsDeliveries/{YYYY-MM-DD}/recipients/{chatId}` – delivery status, worker
  lease, Telegram message ID, and acknowledgment timestamp for each evening report
- `statisticsRequests/{updateId}` – queued manual report, original chat/message,
  processing lease, rendered report, and terminal delivery status

## Firestore access

Firestore is a server-only backend for this bot. Security Rules deny direct
client reads and writes for every collection, including users and market history.
Cloud Functions use the Admin SDK and IAM, so they retain database access without
collection-specific client rules. The deploy script publishes these rules together
with the functions.

## License

MIT License - see [LICENSE](LICENSE) file for details.
