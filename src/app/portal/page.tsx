import { getSessionUser } from '@/lib/auth/session';

export const metadata = { title: 'Portal' };

export default async function PortalHome() {
  // Non-null in practice: the layout redirects signed-out visitors before this renders.
  const user = await getSessionUser();

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold">
        Welcome{user?.displayName ? `, ${user.displayName}` : ''}
      </h1>
      <p className="mt-2 text-muted">
        Your member area. Feature sections land here once the spec is wired in.
      </p>

      <div className="mt-8 rounded-card border border-border bg-surface-raised p-6">
        <h2 className="font-medium">Account</h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Email</dt>
            <dd>{user?.email ?? 'Not set'}</dd>
          </div>
          <div>
            <dt className="text-muted">Access level</dt>
            <dd className="capitalize">{user?.role}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
