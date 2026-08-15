// session.js — session lifetime enforcement on top of Firebase Auth.
//
// Firebase persists a login indefinitely (browserLocalPersistence) and silently
// refreshes the ID token every hour, so without this a signed-in session never
// ends. This guard adds two bounds and forces a real re-login when either trips:
//
//   • Idle timeout      — signed out after IDLE_LIMIT of no user activity.
//   • Absolute lifetime — signed out ABSOLUTE_LIMIT after the last sign-in,
//                         regardless of activity.
//
// It also periodically force-refreshes the ID token so a token revoked
// server-side (e.g. account disabled, password reset) is caught promptly and
// the user is bounced to the login page.
//
// Tunables — change these to adjust the policy (default: 30 min idle / 12 hr max).
const IDLE_LIMIT_MS      = 30 * 60 * 1000;        // 30 minutes of inactivity
const ABSOLUTE_LIMIT_MS  = 12 * 60 * 60 * 1000;   // 12 hours since sign-in
const CHECK_INTERVAL_MS  = 60 * 1000;             // re-evaluate every minute
const ACTIVITY_THROTTLE_MS = 30 * 1000;           // persist activity ≤ every 30s
const TOKEN_REFRESH_MS   = 10 * 60 * 1000;        // force token refresh every 10 min

const LS_LAST_ACTIVITY = 'sess:lastActivity';

import { auth } from './firebase.js';
import {
  onAuthStateChanged,
  signOut as fbSignOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

let _started = false;
let _lastPersist = 0;
let _lastTokenCheck = 0;
let _expiring = false;

function nowMs() { return Date.now(); }

function getLastActivity() {
  const v = Number(localStorage.getItem(LS_LAST_ACTIVITY) || 0);
  return v > 0 ? v : nowMs();
}
function setLastActivity(t) {
  try { localStorage.setItem(LS_LAST_ACTIVITY, String(t)); } catch (e) { /* ignore */ }
}
function clearSession() {
  try { localStorage.removeItem(LS_LAST_ACTIVITY); } catch (e) { /* ignore */ }
}

// Throttled: record that the user did something.
function markActivity() {
  const t = nowMs();
  if (t - _lastPersist >= ACTIVITY_THROTTLE_MS) {
    _lastPersist = t;
    setLastActivity(t);
  }
}

// Absolute-lifetime anchor: Firebase's authoritative last sign-in time. This
// resets on every genuine sign-in and survives reloads, so we don't need to
// track "login time" ourselves.
function signInAnchor(user) {
  const ls = user && user.metadata && user.metadata.lastSignInTime;
  const parsed = ls ? Date.parse(ls) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function expireNow(reason) {
  if (_expiring) return;
  _expiring = true;
  clearSession();
  const next = encodeURIComponent(location.pathname + location.search);
  try { await fbSignOut(auth); } catch (e) { /* ignore */ }
  location.replace(`/login.html?next=${next}&reason=${encodeURIComponent(reason)}`);
}

// Pure check against persisted state — no side effects, safe to call before
// the guard starts. Returns the expiry reason if a limit has already been
// exceeded (e.g. the browser was closed and reopened later), else null.
// Idle time counts from the later of last recorded activity and last sign-in,
// so a fresh login is never expired by a stale activity record.
export function expiredReason(user) {
  if (!user) return null;
  const t = nowMs();
  const anchor = signInAnchor(user);
  if (anchor && (t - anchor) > ABSOLUTE_LIMIT_MS) return 'session-expired';
  const stored = Number(localStorage.getItem(LS_LAST_ACTIVITY) || 0);
  const lastActive = Math.max(stored, anchor || 0);
  if (lastActive > 0 && (t - lastActive) > IDLE_LIMIT_MS) return 'idle-timeout';
  return null;
}

async function checkExpiry() {
  const user = auth && auth.currentUser;
  if (!user) return;
  const t = nowMs();

  // 1) Absolute lifetime.
  const anchor = signInAnchor(user);
  if (anchor && (t - anchor) > ABSOLUTE_LIMIT_MS) {
    return expireNow('session-expired');
  }
  // 2) Idle timeout.
  if ((t - getLastActivity()) > IDLE_LIMIT_MS) {
    return expireNow('idle-timeout');
  }
  // 3) Periodically force a token refresh so a server-side revocation
  //    (disabled account, forced re-auth) is caught and bounces the user.
  if (t - _lastTokenCheck >= TOKEN_REFRESH_MS) {
    _lastTokenCheck = t;
    try {
      await user.getIdToken(true);
    } catch (e) {
      return expireNow('token-invalid');
    }
  }
}

// Start the guard. Idempotent — safe to call from every authed page.
export function startSessionGuard() {
  if (_started) return;
  if (!auth) return; // Firebase failed to init; nothing to guard.
  _started = true;

  // Before touching the clocks, see whether the persisted session already
  // exceeded a limit while no tab was open (browser closed, machine asleep).
  // Seeding first would erase the idle record and silently resume the session.
  const preReason = expiredReason(auth.currentUser);
  if (preReason) { expireNow(preReason); return; }

  // Seed activity + token-check clocks.
  const t = nowMs();
  setLastActivity(t);
  _lastPersist = t;
  _lastTokenCheck = t;

  const activityEvents = ['click', 'keydown', 'scroll', 'mousemove', 'touchstart', 'visibilitychange'];
  activityEvents.forEach((ev) =>
    window.addEventListener(ev, markActivity, { passive: true }));

  // Reset bookkeeping on sign-out so the next login starts a clean clock.
  // When a user appears after the guard started (auth resolved late), re-run
  // the persisted-state check before accepting the session.
  onAuthStateChanged(auth, (u) => {
    if (!u) { clearSession(); return; }
    const r = expiredReason(u);
    if (r) { expireNow(r); return; }
    if (!localStorage.getItem(LS_LAST_ACTIVITY)) { setLastActivity(nowMs()); }
  });

  setInterval(checkExpiry, CHECK_INTERVAL_MS);
  checkExpiry();
}
