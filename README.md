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
   - Set up your Firebase project configuration
   - ...

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

## Environment Variables

Set environment variables...

## License

MIT License - see [LICENSE](LICENSE) file for details.
