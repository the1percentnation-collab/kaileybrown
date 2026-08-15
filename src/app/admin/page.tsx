import SiteContentEditor from '@/components/SiteContentEditor';
import { getSiteContent } from '@/lib/content';
import { isAdminConfigured } from '@/lib/firebase/admin';

export const metadata = { title: 'Site content' };

// Always read the live document so the editor never opens against a cached copy.
export const dynamic = 'force-dynamic';

export default async function AdminContentPage() {
  const content = await getSiteContent();

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold">Site content</h1>
      <p className="mt-2 text-sm text-muted">
        Edit the public site here. Changes go live as soon as you save.
      </p>

      {!isAdminConfigured() ? (
        <p className="mt-6 rounded-card border border-border bg-surface-raised p-4 text-sm text-muted">
          Firebase Admin is not configured, so saving is disabled and the defaults below are
          shown. Set the server credentials in <code>.env.local</code> to enable editing.
        </p>
      ) : null}

      <div className="mt-8">
        <SiteContentEditor initial={content} disabled={!isAdminConfigured()} />
      </div>
    </div>
  );
}
