import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/auth/constants';

/**
 * Cheap first gate only. Middleware runs on the edge runtime, where
 * firebase-admin cannot run, so this checks for the presence of a session
 * cookie and nothing more. Real verification (signature, expiry, revocation,
 * role) happens server-side in the protected layouts, which is what actually
 * enforces access.
 */
export function middleware(request: NextRequest) {
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!hasCookie) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/portal/:path*', '/admin/:path*'],
};
