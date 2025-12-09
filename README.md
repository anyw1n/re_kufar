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
- `npm run serve` - Start Firebase emulators
- `npm run deploy` - Deploy functions to Firebase
- `npm run logs` - View function logs

## Functions

- `tgWebhook` (HTTPS): Telegram webhook endpoint; sets the webhook to `WEBHOOK_URL` on cold start.
- `kufarScraper` (Scheduled): In production runs every minute to poll Kufar and push new ads. In local emulators it is exposed as `http://localhost:5001/<project-id>/us-central1/kufarScraper` for manual triggering.

## Environment Variables

Defined in `.env.local` / `.env.prod`:

- `BOT_TOKEN` – Telegram bot token from BotFather.
- `WEBHOOK_URL` – HTTPS URL of the deployed `tgWebhook` function.

## Data Model

- Collection `users/{chatId}`
  - `filters` – user-selected `city`, `minCost`, `maxCost`, `rooms[]`
  - `notificationsEnabled` – whether the user receives updates
  - `lastAdTime` – timestamp of the last ad sent

## License

MIT License - see [LICENSE](LICENSE) file for details.
