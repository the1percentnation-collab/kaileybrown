import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import SignOutButton from '@/components/SignOutButton';
import { getSessionUser } from '@/lib/auth/session';

/**
 * Admin gate. Signed-out visitors go to login. Signed-in non-admins get a 404
 * rather than a "forbidden" page, so the admin area is not advertised to
 * ordinary members.
 *
 * Never cached: a protected page must be evaluated per request.
 */
export const dynamic = 'force-dynamic';


export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/admin');
  if (user.role !== 'admin') notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/admin" className="font-display font-semibold">
            Admin
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-muted hover:text-ink">
              Site content
            </Link>
            <Link href="/portal" className="text-muted hover:text-ink">
              Portal
            </Link>
            <Link href="/" className="text-muted hover:text-ink">
              View site
            </Link>
            <SignOutButton />
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}
