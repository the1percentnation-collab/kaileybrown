// Referral capture — affiliate attribution for the affiliate program.
//
// Importing this module captures ?ref=CODE from the URL into localStorage
// (60-day attribution window) and pings the recordAffiliateClick callable
// once per browser session per code. courses-page.js reads getRefCode() and
// passes it to createCheckoutSession, which validates it server-side.

import { functions, firebaseReady } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const LS_KEY = 'kb_ref';
const SS_KEY = 'kb_ref_clicked';
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export function captureRef() {
  let code = null;
  try {
    code = new URLSearchParams(location.search).get('ref');
  } catch (e) { return; }
  if (!code) return;
  code = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  if (!code) return;

  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ code, ts: Date.now() }));
  } catch (e) {}

  // Count the click once per session per code (best-effort).
  try {
    if (firebaseReady && sessionStorage.getItem(SS_KEY) !== code) {
      sessionStorage.setItem(SS_KEY, code);
      httpsCallable(functions, 'recordAffiliateClick')({ code }).catch(() => {});
    }
  } catch (e) {}
}

/** The stored referral code if it's still inside the attribution window. */
export function getRefCode() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { code, ts } = JSON.parse(raw);
    if (!code || !ts || Date.now() - ts > WINDOW_MS) return null;
    return code;
  } catch (e) { return null; }
}

captureRef();
