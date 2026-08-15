import { NextResponse } from 'next/server';

import {
  clearSessionCookie,
  createSessionCookie,
  setSessionCookie,
} from '@/lib/auth/session';

export const runtime = 'nodejs';

/** Sign in: trade a Firebase ID token for an httpOnly session cookie. */
export async function POST(request: Request) {
  let idToken: unknown;

  try {
    ({ idToken } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof idToken !== 'string' || !idToken) {
    return NextResponse.json({ error: 'Missing ID token.' }, { status: 400 });
  }

  try {
    const cookie = await createSessionCookie(idToken);
    await setSessionCookie(cookie);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to create session', error);
    // Deliberately generic: do not leak whether the token was expired, forged, or revoked.
    return NextResponse.json({ error: 'Could not start a session.' }, { status: 401 });
  }
}

/** Sign out. */
export async function DELETE() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
