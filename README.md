# Kailey Brown

Public marketing site plus a login-protected member portal and an admin area for
editing site content.

Status: this is the foundation. Auth, session handling, route protection, and the
site-content editor work end to end. Member portal features are placeholders
until the feature spec is wired in.

## Stack

- Next.js 15 (App Router) and React 19
- Firebase Auth for identity (email/password and Google)
- Firestore for site content and user records
- Tailwind CSS, themed from CSS variables in one file

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000. Without Firebase credentials the public site still
renders from built-in defaults, and the auth screens explain what is missing.

### Firebase setup

1. Create a Firebase project.
2. Enable **Authentication > Sign-in method > Email/Password** and **Google**.
3. Create a **Web app** and copy its config into the `NEXT_PUBLIC_FIREBASE_*`
   values in `.env.local`.
4. Create a **Firestore** database.
5. Under **Project settings > Service accounts**, generate a private key and copy
   `project_id`, `client_email`, and `private_key` into the `FIREBASE_*` values.
6. Put your own email in `ADMIN_EMAILS` so you can reach `/admin` on first sign-in.
7. Deploy the rules in `firestore.rules` to your project.

## How access control works

Two layers, and only the second one enforces anything:

- `src/middleware.ts` runs on the edge runtime, where the Firebase Admin SDK
  cannot run. It only checks that a session cookie is present and redirects to
  `/login` when it is not. This is a fast redirect, not a security boundary.
- The protected layouts (`src/app/portal/layout.tsx`, `src/app/admin/layout.tsx`)
  verify the session cookie's signature, expiry, and revocation status with the
  Admin SDK before rendering. This is the actual gate.

Server actions are public HTTP endpoints, so `src/app/admin/actions.ts` re-checks
the admin role on every mutation rather than trusting the layout.

Roles resolve in this order: the `ADMIN_EMAILS` allowlist first (the bootstrap
path, so the first admin can sign in before any Firestore document exists), then
the user's Firestore document, then `member` as the default.

## Editing the site

Sign in with an admin account and open `/admin`. Fields there write to the
`siteContent/main` Firestore document, which the public site reads. Every field
falls back to a default in `src/lib/content.ts`, so a partially filled document
still renders a complete page.

## Theming

All brand colors, fonts, and radii are CSS variables in
`src/styles/globals.css`. Change them there to re-skin the site; no component
needs to be touched. Current values are neutral placeholders pending brand
direction.

## Project layout

```
src/
  app/
    admin/            Protected admin area and its server actions
    api/auth/session/ Session cookie create and destroy
    login/ signup/    Auth screens
    portal/           Protected member area
    page.tsx          Public marketing page
  components/         Client components (auth form, content editor)
  lib/
    auth/             Session verification, role resolution, shared constants
    firebase/         Client SDK and Admin SDK setup
    content.ts        Site content read, write, and sanitize
```

## Scripts

```bash
npm run dev        # development server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
```

## Security notes

- `NEXT_PUBLIC_FIREBASE_*` values ship to the browser by design. Firebase web
  config is not secret; access is enforced by security rules and server-side
  session checks.
- The service account key is server-only and must never be committed.
  `.gitignore` covers `.env*.local` and `*-service-account*.json`.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- `firestore.rules` closes everything by default and denies self-promotion to
  the admin role.
