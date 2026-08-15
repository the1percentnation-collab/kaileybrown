'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { signOut } from 'firebase/auth';

import { clientAuth, isFirebaseConfigured } from '@/lib/firebase/client';

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);

    // Clear the server session first. Even if the client SDK call fails,
    // the httpOnly cookie is already gone, so the user is signed out.
    await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => undefined);

    if (isFirebaseConfigured()) {
      await signOut(clientAuth()).catch(() => undefined);
    }

    router.replace('/');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      className="text-muted hover:text-ink disabled:opacity-60"
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
