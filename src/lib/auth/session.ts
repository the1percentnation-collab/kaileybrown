import 'server-only';

import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/lib/auth/constants';
import { adminAuth, adminDb, isAdminConfigured } from '@/lib/firebase/admin';
import type { AppRole, SessionUser } from '@/lib/types';

export { SESSION_COOKIE };

/** Firebase session cookies max out at 14 days. */
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Exchanges a short-lived Firebase ID token for a long-lived session cookie.
 * The ID token is verified first so a forged token cannot mint a session.
 */
export async function createSessionCookie(idToken: string): Promise<string> {
  const decoded = await adminAuth().verifyIdToken(idToken, true);

  // Reject tokens minted before a recent sign-in to limit replay of stolen tokens.
  const authAgeSeconds = Date.now() / 1000 - decoded.auth_time;
  if (authAgeSeconds > 5 * 60) {
    throw new Error('Sign-in is too old to start a session. Please sign in again.');
  }

  return adminAuth().createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
}

/**
 * Reads and verifies the current session. Returns null when signed out,
 * when the cookie is invalid or expired, or when the account was revoked.
 * Never throws on a bad cookie: callers treat null as "signed out".
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isAdminConfigured()) return null;

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  try {
    // checkRevoked: true so disabling a user or revoking tokens takes effect immediately.
    const decoded = await adminAuth().verifySessionCookie(cookie, true);
    const role = await resolveRole(decoded.uid, decoded.email ?? null);

    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      displayName: (decoded.name as string | undefined) ?? null,
      photoURL: (decoded.picture as string | undefined) ?? null,
      role,
    };
  } catch {
    return null;
  }
}

/**
 * Role resolution, in priority order:
 *   1. ADMIN_EMAILS env allowlist. This is the bootstrap path so the first
 *      admin can sign in before any Firestore document exists.
 *   2. The user's Firestore document.
 * Anything else is a member.
 */
async function resolveRole(uid: string, email: string | null): Promise<AppRole> {
  if (email && adminEmails().includes(email.toLowerCase())) return 'admin';

  try {
    const snap = await adminDb().collection('users').doc(uid).get();
    const role = snap.get('role');
    if (role === 'admin' || role === 'member') return role;
  } catch {
    // Firestore unavailable. Fall through to the least-privileged role.
  }

  return 'member';
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function setSessionCookie(value: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
