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

Use the same `.env` values on PC and mobile builds. When `VITE_FIREBASE_DATABASE_URL` and `VITE_FIREBASE_SYNC_ID` are set, every `window.storage` read/write goes through Firebase Realtime Database. Existing browser-local todo keys are uploaded to Firebase the first time they are read.

Todo day data is stored at:

```text
rooms/{VITE_FIREBASE_SYNC_ID}/days/{YYYY-MM-DD}
rooms/{VITE_FIREBASE_SYNC_ID}/meta/lastRollover
```

For a private production app, replace open database rules with Firebase Auth based rules.

## Mobile App

### Recommended: PWA Home Screen App

This project already includes a web app manifest and service worker, so the simplest mobile app path is Firebase Hosting + "Add to Home Screen".

```bash
npm run build
firebase deploy --only hosting
```

Open the deployed URL on mobile:

```text
https://fable-todo.web.app
```

Android Chrome:

1. Open the URL.
2. Tap the browser menu.
3. Tap "Install app" or "Add to Home screen".

iPhone Safari:

1. Open the URL in Safari.
2. Tap Share.
3. Tap "Add to Home Screen".

The installed icon uses the same Firebase Realtime Database data as the PC app when the same `.env` values are used before deployment.

### Native APK/IPA Later: Capacitor

Use this only when you need an Android APK/AAB or iOS App Store build.

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Fable Todo" "com.jungsil.fabletodo" --web-dir=dist
npm install @capacitor/android
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

For iPhone native builds, run the iOS commands on macOS with Xcode:

```bash
npm install @capacitor/ios
npm run build
npx cap add ios
npx cap sync ios
npx cap open ios
```

Prefer the PWA route unless a store package is actually needed.
