// Firebase initialization — CDN modular imports (no bundler).
// All keys here are public per Firebase web SDK guidance; security comes from Firestore rules.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js';

// Web app config for the kaileybrown-48e22 project.
//
// These are public by design and are meant to ship to the browser. Firebase web
// API keys are not secrets: all security in this app comes from the Firestore
// and Storage rules plus the callable-side auth checks. Do not try to hide them
// or move them into environment variables — the client needs them to boot.
//
// The real secret is the service-account key, which lives only in the GitHub
// Actions secret and is never in this repo.
export const firebaseConfig = {
  apiKey: "AIzaSyB3ebNvy_krUc3GrunmGSudcMln9IJhOZc",
  authDomain: "kaileybrown-48e22.firebaseapp.com",
  projectId: "kaileybrown-48e22",
  storageBucket: "kaileybrown-48e22.firebasestorage.app",
  messagingSenderId: "192030174948",
  appId: "1:192030174948:web:01232f5f010ae808f446f1",
  measurementId: "G-1Z4PKNDLHG"
};

// ── Firebase App Check (bot / abuse protection) ─────────────────────────────
// App Check attests that calls come from THIS web app (not a script hitting the
// API directly). To turn it on:
//   1. Firebase Console > App Check > register this web app with the
//      reCAPTCHA v3 provider; copy the site key.
//   2. Paste the site key below (RECAPTCHA_V3_SITE_KEY).
//   3. Optionally set `enforceAppCheck: true` on sensitive callables in
//      functions/index.js once you've confirmed tokens are flowing.
// Leaving the key blank makes App Check a no-op, so nothing breaks before it's
// configured. See AUTH_SETUP.md.
const RECAPTCHA_V3_SITE_KEY = ""; // <-- paste your reCAPTCHA v3 site key here

let _app, _auth, _db, _functions, _appCheck;
let _initError = null;

try {
  _app = initializeApp(firebaseConfig);

  // Initialize App Check before other services if a site key is configured.
  if (RECAPTCHA_V3_SITE_KEY) {
    try {
      _appCheck = initializeAppCheck(_app, {
        provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
        isTokenAutoRefreshEnabled: true
      });
    } catch (acErr) {
      console.warn('[firebase] App Check init failed (continuing without it):', acErr);
    }
  }

  _auth = getAuth(_app);
  _db = getFirestore(_app);
  _functions = getFunctions(_app);
  // Persist sessions across tabs/reloads.
  setPersistence(_auth, browserLocalPersistence).catch(() => {});
} catch (err) {
  _initError = err;
  console.error('[firebase] init failed:', err);
}

export const appCheck = _appCheck;

export const app = _app;
export const auth = _auth;
export const db = _db;
export const functions = _functions;
export const initError = _initError;

// Convenience flag: did Firebase initialize well enough to try remote calls?
export const firebaseReady = !!(_app && _auth && _db);
