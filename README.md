# Kailey Brown

Public marketing site plus a login-protected member portal, on Firebase.

Ported from the `The-1P-Leadership` platform per the port manifest, then
rebranded: same engine, new brand, empty catalog.

## Stack

A **buildless static multi-page app** on Firebase Hosting, plus **one Cloud
Functions v2 file** (Node 20, CommonJS).

There is no bundler, no npm on the frontend, no TypeScript, and no build step.
The only npm project in the repo is `functions/`. Everything in `public/` is
deployed byte-for-byte as written, and every browser dependency loads from a CDN
URL. **Do not add a build step** without treating it as its own project: bare
`import` URL specifiers break the moment a bundler is introduced.

| Library | Version | Used by |
|---|---|---|
| Firebase JS SDK | 10.12.0 | everything |
| Quill | 2.0.2 | course builder editor |
| DOMPurify | 3.1.6 | sanitising builder HTML |
| pdfjs-dist | 4 | PDF import |
| mammoth | 1 | .docx import |
| html2canvas | 1.4.1 | bug-report screenshots |

## Before this deploys

These cannot be guessed and the site will not work until they are set.

1. **`public/js/firebase.js`** — two values left: `apiKey` and `appId`. They are
   generated when the Web app is registered, so copy them from Firebase console
   → Project settings → General → Your apps → SDK setup. Everything else is
   already filled in for project `kaileybrown-48e22`. The placeholders are
   deliberately invalid so a half-configured deploy fails loudly instead of
   writing to the wrong project.
2. **GA4** — replace `G-REPLACE_WITH_GA4_ID` across `public/*.html` with a real
   measurement ID, or strip the analytics snippet.
3. **Owner mailbox** — `kailey@kaileybrown.com` must exist and be reachable
   before first deploy: you sign up with it to claim ownership. It is a hard
   gate, not a display string, and must stay byte-identical in
   `functions/index.js` and `public/js/auth.js`.
4. **Legal pages** — `privacy.html` and `terms.html` still contain
   `[[PLACEHOLDER]]` tokens for legal business name, mailing address, governing
   state, refund policy and effective date. Fill them in and have counsel
   review.
5. **Fonts** — `Audrey` is the display face and is **not** a Google Font. License
   it for web use, convert to `.woff2`, and drop it at
   `public/assets/fonts/audrey.woff2`. Until then every display usage falls back
   to Jost, which is a near match, so nothing looks broken.
6. **Images** — the previous brand's photography and video were removed rather
   than reused. Add your own at the paths marked `TODO(assets)` in
   `public/index.html` and `public/courses.html`.

See `AUTH_SETUP.md` for the full Firebase project checklist.

## Setup

Follow `AUTH_SETUP.md`, then:

```bash
npx firebase-tools login
cd functions && npm install && cd ..
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage --project kaileybrown-48e22
npx firebase-tools deploy --only functions --project kaileybrown-48e22
npx firebase-tools deploy --only hosting --project kaileybrown-48e22
```

Or push to `main` and let the workflows run. CI needs a repo secret named
`FIREBASE_SERVICE_ACCOUNT_KAILEY_BROWN`.

### Claim ownership

Sign up at `/signup.html` with exactly the owner email, then visit `/owner.html`
and click **Run bootstrapOwner**. A `permission-denied` here means you are not
signed in as that exact address, or the two `OWNER_EMAIL` constants disagree.

## Theming

Every colour and type token lives in **`public/assets/tokens.css`** — one file,
imported by `styles.css` and linked directly by pages with their own inline
styles. Change the theme there and nothing else needs to move.

The palette is white paper, charcoal ink, red as punctuation. Red carries
meaning: the single primary action on a screen, the active nav state, the logo
mark, and genuine error states. Everything else is ink on paper.

That file also defines **legacy aliases** (`--black`, `--white`, `--surface2`, …)
re-pointed at their new roles, which is how thousands of ported call sites
inverted at once. `--white` now resolves to dark ink and `--black` to paper —
that is intentional. Use the role names (`--ink`, `--paper`, `--surface`) in new
code and let the aliases fade out. Do not "fix" `--black` back to black.

## Courses

The catalog starts empty and the public site does not advertise courses. Build
them through the admin CMS at `/manage-courses.html`, or generate one with the AI
flow. `public/js/courses-registry.js` documents the entry schema for the rare
case of a course authored in code.

## Layout

```
functions/index.js     52 exports: callables, Firestore triggers, webhooks
firestore.rules        the authorization layer
firestore.indexes.json 19 composite indexes; queries fail at runtime without them
storage.rules          per-prefix upload rules with size and MIME limits
public/*.html          39 pages, one controller each
public/js/             55 modules in four layers: foundation, services,
                       UI shells, page controllers. Flat directory, no subfolders.
public/assets/         tokens.css and the logo
```

## Things that look like cruft and are not

- **Fail open on infrastructure, fail closed on authorization.** The onboarding
  guard, role cache and rate limiter deliberately let requests through when
  Firestore errors; rules and callable auth checks always deny. Do not "fix"
  either direction.
- **`enrolledCourseSlugs` is server-only.** It is frozen against self-writes in
  the rules, which is what makes it safe to gate paid content on. The moment a
  client can write it, every paid course is free.
- **The `?v=N` cache-bust convention.** JS and CSS ship with
  `Cache-Control: no-cache` and there is no content hashing, so bump the query
  string when you change a versioned file.
- **`esc()` is duplicated on purpose** across `crm.js`, `products.js`,
  `community.js`, `crm-shell.js` and `course-player.js`, to avoid cross-imports
  between layers. Rendering is `innerHTML` from template literals throughout, so
  every interpolation of user data must go through the local `esc()`.
- **CI deploys rules first, alone, before `npm install`.** A secrets lookup
  failure in the functions deploy must not take the security rules down with it.
- **The public/private community trigger pairs.** Eight triggers, four logical
  events, two Firestore paths. Dropping one silently breaks notifications and
  points for private channels.
- **`cleanUrls` and the catch-all rewrite coexist.** Real files win, so every
  page is reachable both as `/courses.html` and `/courses`, and only unknown
  paths fall through to the marketing home page.
