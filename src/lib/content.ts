import 'server-only';

import { adminDb, isAdminConfigured } from '@/lib/firebase/admin';
import type { SiteContent } from '@/lib/types';

const CONTENT_COLLECTION = 'siteContent';
const CONTENT_DOC = 'main';

/**
 * Shipping defaults. The public site renders from these until an admin saves
 * content, so a fresh deploy is never blank and never shows raw keys.
 */
export const DEFAULT_CONTENT: SiteContent = {
  brandName: 'Kailey Brown',
  tagline: 'Placeholder tagline. Edit this in the admin dashboard.',
  heroHeading: 'Welcome',
  heroSubheading:
    'This copy is editable from the protected admin dashboard. Sign in, open Site Content, and save your changes.',
  heroCtaLabel: 'Join the portal',
  heroCtaHref: '/signup',
  aboutHeading: 'About',
  aboutBody:
    'Placeholder about section. Replace this from the admin dashboard once your positioning copy is ready.',
  contactEmail: '',
};

export async function getSiteContent(): Promise<SiteContent> {
  if (!isAdminConfigured()) return DEFAULT_CONTENT;

  try {
    const snap = await adminDb().collection(CONTENT_COLLECTION).doc(CONTENT_DOC).get();
    if (!snap.exists) return DEFAULT_CONTENT;

    // Merge over defaults so a partially filled document still renders fully.
    return { ...DEFAULT_CONTENT, ...(snap.data() as Partial<SiteContent>) };
  } catch {
    return DEFAULT_CONTENT;
  }
}

export async function saveSiteContent(
  patch: Partial<SiteContent>,
  updatedBy: string,
): Promise<void> {
  const clean = sanitize(patch);

  await adminDb()
    .collection(CONTENT_COLLECTION)
    .doc(CONTENT_DOC)
    .set(
      { ...clean, updatedAt: new Date().toISOString(), updatedBy },
      { merge: true },
    );
}

/**
 * Accepts only known content keys with string values, so a crafted request
 * cannot write arbitrary fields into the content document.
 */
function sanitize(patch: Partial<SiteContent>): Partial<SiteContent> {
  const allowed: (keyof SiteContent)[] = [
    'brandName',
    'tagline',
    'heroHeading',
    'heroSubheading',
    'heroCtaLabel',
    'heroCtaHref',
    'aboutHeading',
    'aboutBody',
    'contactEmail',
  ];

  const out: Partial<SiteContent> = {};
  for (const key of allowed) {
    const value = patch[key];
    if (typeof value === 'string') {
      out[key] = value.slice(0, 5000).trim();
    }
  }
  return out;
}
