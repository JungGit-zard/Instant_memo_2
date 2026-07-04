# Fable Todo

React/Vite daily todo app with optional Firebase Realtime Database sync.

## Run

```bash
npm install
npm run dev -- --port 5174
```

## Firebase Realtime Database Sync

Create `.env` from `.env.example` and fill the Firebase web app values:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_SYNC_ID=your-private-room-id
```

Use the same `.env` values on PC and mobile builds. Todo day data is stored at:

```text
rooms/{VITE_FIREBASE_SYNC_ID}/days/{YYYY-MM-DD}
rooms/{VITE_FIREBASE_SYNC_ID}/meta/lastRollover
```

For a private production app, replace open database rules with Firebase Auth based rules.
