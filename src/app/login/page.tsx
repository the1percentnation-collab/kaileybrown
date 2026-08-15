import Link from 'next/link';
import { redirect } from 'next/navigation';

import AuthForm from '@/components/AuthForm';
import { getSessionUser } from '@/lib/auth/session';
import { safeNext } from '@/lib/safe-next';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next, '/portal');

  if (await getSessionUser()) redirect(next);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-3xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted">Access your member portal.</p>

      <div className="mt-8">
        <AuthForm mode="login" next={next} />
      </div>

      <p className="mt-6 text-sm text-muted">
        No account yet?{' '}
        <Link href="/signup" className="font-medium text-accent">
          Create one
        </Link>
      </p>
    </main>
  );
}
