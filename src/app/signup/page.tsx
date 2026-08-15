import Link from 'next/link';
import { redirect } from 'next/navigation';

import AuthForm from '@/components/AuthForm';
import { getSessionUser } from '@/lib/auth/session';
import { safeNext } from '@/lib/safe-next';

export const metadata = { title: 'Create account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next, '/portal');

  if (await getSessionUser()) redirect(next);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-3xl font-semibold">Create your account</h1>
      <p className="mt-2 text-sm text-muted">Join the member portal.</p>

      <div className="mt-8">
        <AuthForm mode="signup" next={next} />
      </div>

      <p className="mt-6 text-sm text-muted">
        Already a member?{' '}
        <Link href="/login" className="font-medium text-accent">
          Sign in
        </Link>
      </p>
    </main>
  );
}
