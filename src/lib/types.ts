export type AppRole = 'admin' | 'member';

export interface SessionUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: AppRole;
}

/**
 * Editable site content. The admin CMS writes this document, the public site
 * reads it. Every field has a fallback in src/lib/content.ts so the site
 * renders correctly before anything has been saved.
 */
export interface SiteContent {
  brandName: string;
  tagline: string;
  heroHeading: string;
  heroSubheading: string;
  heroCtaLabel: string;
  heroCtaHref: string;
  aboutHeading: string;
  aboutBody: string;
  contactEmail: string;
  updatedAt?: string;
  updatedBy?: string;
}
