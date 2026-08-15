import Link from 'next/link';
import { redirect } from 'next/navigation';

import SignOutButton from '@/components/SignOutButton';
import { getSessionUser } from '@/lib/auth/session';
import { getSiteContent } from '@/lib/content';

/**
 * This is the real access gate. Middleware only checks that a cookie exists;
 * here the cookie is cryptographically verified before anything renders.
 *
 * Never cached: a protected page must be evaluated per request.
 */
export const dynamic = 'force-dynamic';


export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/portal');

  const content = await getSiteContent();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/portal" className="font-display font-semibold">
            {content.brandName}
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            <Link href="/portal" className="text-muted hover:text-ink">
              Dashboard
            </Link>
            {user.role === 'admin' ? (
              <Link href="/admin" className="font-medium text-accent">
                Admin
              </Link>
            ) : null}
            <SignOutButton />
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}
