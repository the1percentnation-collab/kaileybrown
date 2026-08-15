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

// ⚠️ TWO VALUES STILL REQUIRED BEFORE FIRST DEPLOY.
//
// The project-derived fields below are filled in for kaileybrown-48e22
// (project number 192030174948). `apiKey` and `appId` are generated when the
// Web app itself is registered, so they cannot be derived — copy them from:
//   Project settings → General → Your apps → SDK setup and configuration.
// If there is no Web app listed there yet, click the </> button to create one.
//
// The placeholders are deliberately invalid so a half-configured deploy fails
// loudly instead of silently pointing at the wrong project.
//
// These are all public by design. Firebase web config ships to every browser;
// security comes from the Firestore/Storage rules and the callable-side auth
// checks, never from keeping these secret.
export const firebaseConfig = {
  apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain: "kaileybrown-48e22.firebaseapp.com",
  projectId: "kaileybrown-48e22",
  // Projects created before ~Oct 2024 use "<id>.appspot.com" instead. Check the
  // bucket name in the console under Storage if uploads 404.
  storageBucket: "kaileybrown-48e22.firebasestorage.app",
  messagingSenderId: "192030174948",
  appId: "REPLACE_WITH_APP_ID",
  // Optional: only used if you enable Google Analytics on the project.
  measurementId: "REPLACE_WITH_GA4_MEASUREMENT_ID"
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
