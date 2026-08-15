import Link from 'next/link';

import { getSessionUser } from '@/lib/auth/session';
import { getSiteContent } from '@/lib/content';

/**
 * Rendered per request: it reads live site content and reflects signed-in
 * state in the header. Pinned here so the build does not silently prerender
 * it as static when Firebase env vars happen to be absent at build time.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [content, user] = await Promise.all([getSiteContent(), getSessionUser()]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Link href="/" className="font-display text-lg font-semibold">
            {content.brandName}
          </Link>
          <div className="flex items-center gap-4 text-sm">
            {user ? (
              <Link href="/portal" className="font-medium text-accent">
                Go to portal
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-muted hover:text-ink">
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-full bg-accent px-4 py-2 font-medium text-accent-ink"
                >
                  Join
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-6 py-24">
          <p className="text-sm uppercase tracking-widest text-muted">{content.tagline}</p>
          <h1 className="mt-4 max-w-2xl font-display text-5xl font-semibold leading-tight">
            {content.heroHeading}
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted">{content.heroSubheading}</p>
          <Link
            href={content.heroCtaHref}
            className="mt-10 inline-block rounded-full bg-accent px-7 py-3 font-medium text-accent-ink"
          >
            {content.heroCtaLabel}
          </Link>
        </section>

        <section className="border-t border-border bg-surface-raised">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <h2 className="font-display text-3xl font-semibold">{content.aboutHeading}</h2>
            <p className="mt-5 max-w-2xl whitespace-pre-line text-muted">{content.aboutBody}</p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-10 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>
            &copy; {new Date().getFullYear()} {content.brandName}
          </span>
          {content.contactEmail ? (
            <a href={`mailto:${content.contactEmail}`} className="hover:text-ink">
              {content.contactEmail}
            </a>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
