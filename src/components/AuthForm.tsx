'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';

import { clientAuth, isFirebaseConfigured } from '@/lib/firebase/client';

type Mode = 'login' | 'signup';

export default function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = isFirebaseConfigured();

  /** Hands the freshly minted ID token to the server, which sets the session cookie. */
  async function startSession(idToken: string) {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? 'Could not start a session.');
    }

    // Full navigation so server components re-render with the new session.
    router.replace(next);
    router.refresh();
  }

  async function handleEmailSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const auth = clientAuth();
      const credential =
        mode === 'signup'
          ? await createUserWithEmailAndPassword(auth, email, password)
          : await signInWithEmailAndPassword(auth, email, password);

      if (mode === 'signup' && displayName.trim()) {
        await updateProfile(credential.user, { displayName: displayName.trim() });
      }

      await startSession(await credential.user.getIdToken());
    } catch (caught) {
      setError(friendlyError(caught));
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);

    try {
      const credential = await signInWithPopup(clientAuth(), new GoogleAuthProvider());
      await startSession(await credential.user.getIdToken());
    } catch (caught) {
      setError(friendlyError(caught));
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <p className="rounded-card border border-border bg-surface-raised p-4 text-sm text-muted">
        Firebase is not configured yet. Copy <code>.env.example</code> to{' '}
        <code>.env.local</code>, fill in your Firebase project values, and restart the dev
        server.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <form onSubmit={handleEmailSubmit} className="space-y-4">
        {mode === 'signup' ? (
          <Field
            label="Name"
            type="text"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="name"
          />
        ) : null}

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
          minLength={8}
        />

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-full bg-accent px-6 py-3 font-medium text-accent-ink disabled:opacity-60"
        >
          {busy ? 'Working...' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={handleGoogle}
        disabled={busy}
        className="w-full rounded-full border border-border px-6 py-3 font-medium disabled:opacity-60"
      >
        Continue with Google
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3.5 py-2.5"
        {...rest}
      />
    </div>
  );
}

/** Maps Firebase error codes to readable text without revealing which accounts exist. */
function friendlyError(caught: unknown): string {
  const code = (caught as { code?: string })?.code ?? '';

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password combination did not work.';
    case 'auth/email-already-in-use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'auth/weak-password':
      return 'Use a password of at least 8 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/popup-closed-by-user':
      return 'The Google sign-in window closed before finishing.';
    default:
      return caught instanceof Error ? caught.message : 'Something went wrong.';
  }
}
