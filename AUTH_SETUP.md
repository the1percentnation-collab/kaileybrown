# 1P-CLC Auth — One-Time Setup Checklist

Do these steps IN ORDER before auth will work end-to-end. Everything below happens in the Google/Firebase consoles — code is already wired up.

---

## 1. Upgrade to Blaze plan (required for Cloud Functions)

1. Open <https://console.firebase.google.com/project/the-1p-leadership/usage/details>
2. Click **Modify plan** → choose **Blaze (pay as you go)**.
3. Link a billing account. (Free quotas still apply; you only pay for overage.)

Why: Cloud Functions v2 cannot deploy on the Spark plan.

---

## 2. Enable Firestore Database

1. Open <https://console.firebase.google.com/project/the-1p-leadership/firestore>
2. Click **Create database**.
3. Region: **us-central1** (nam5 also fine, but keep it consistent with Functions).
4. Start in **Production mode** — the custom rules in `firestore.rules` will be deployed on push.

---

## 3. Enable Auth sign-in methods

1. Open <https://console.firebase.google.com/project/the-1p-leadership/authentication/providers>
2. Enable **Email/Password**.
3. Enable **Google** (pick a project support email — the owner email is fine).

---

## 4. First deploy + bootstrap the owner claim

1. Push to `main` — this triggers BOTH workflows:
   - `firebase-hosting-merge.yml` (already existed) → deploys `public/`
   - `firebase-deploy-backend.yml` (new) → deploys `firestore.rules` + `functions/`
2. Once the backend workflow is green, visit <https://the-1p-leadership.web.app/signup.html> and create an account with **the1percentnation@gmail.com**. (Or sign in with that Google account.)
3. Go to <https://the-1p-leadership.web.app/owner.html>. You'll see a notice that you are not yet an owner. Click **Run bootstrapOwner**.
4. The page reloads. You now have the `role=owner` custom claim and can create companies.

> If bootstrapOwner fails with `permission-denied`, double-check that you are signed in as exactly `the1percentnation@gmail.com` (case-insensitive, but it must be that address).

---

## 5. Grant extra IAM roles to the GitHub Actions service account

The existing secret `FIREBASE_SERVICE_ACCOUNT_THE_1P_LEADERSHIP` grants hosting deploys. For Firestore rules + Functions deploys it needs more.

1. Open <https://console.cloud.google.com/iam-admin/iam?project=the-1p-leadership>
2. Find the service account tied to the existing GitHub workflow (looks like `github-action-XXXXXXXXX@the-1p-leadership.iam.gserviceaccount.com`).
3. Add these roles:
   - **Firebase Rules Admin** (`roles/firebaserules.admin`)
   - **Cloud Functions Developer** (`roles/cloudfunctions.developer`)
   - **Service Account User** (`roles/iam.serviceAccountUser`)
   - Also helpful: **Artifact Registry Writer** (Functions v2 stores images in Artifact Registry) and **Cloud Run Admin** (v2 functions run on Cloud Run under the hood).

---

## Manual local deploy (first time, if you want to do it before the workflow runs)

```bash
npx firebase-tools login
cd functions && npm install && cd ..
npx firebase-tools deploy --only firestore:rules,functions --project the-1p-leadership
```

Firestore rules deploy **separately** from hosting. Hosting continues to auto-deploy via the existing workflow on every push.

---

## Smoke test after setup

1. `https://the-1p-leadership.web.app/login.html` — sign in as the owner email.
2. `/owner.html` — create a company, assign an admin by email. (That admin must have already signed up at `/signup.html` so their user doc exists.)
3. That admin signs in and goes to `/admin.html` — they should see the roster + can generate invites.
4. Send the invite link to an employee. They open it, sign up, and land on `/index.html`. Their `companyId` is now set and seats used has incremented.

---

## Security & compliance hardening (added in the security audit)

These changes are wired in code and deploy automatically. A few require a
one-time console step or content edit to fully activate.

### Rate limiting (active on deploy — no setup)
Expensive/abusable callables are throttled by a Firestore-backed limiter
(`rateLimits/{doc}`, server-only). Limits: AI chat 20/5 min per user, bug
reports 5/10 min per uid+IP, contact email 60/10 min, campaigns 10/hr, SMS
100/10 min, checkout 15/10 min, community invites 30/hr, affiliate clicks
30/10 min per IP, data export 5/hr. Tune the numbers in `functions/index.js`
(search `rateLimitCaller` / `enforceRateLimit`). Optionally add a Firestore TTL
policy on `rateLimits.expiresAt` to auto-prune old counters.

### Firebase App Check (optional — off until you add a key)
App Check adds bot/abuse attestation. To enable:
1. Firebase Console → **App Check** → register this web app with the
   **reCAPTCHA v3** provider; copy the site key.
2. Paste it into `RECAPTCHA_V3_SITE_KEY` in `public/js/firebase.js`.
3. After confirming tokens flow (Console → App Check → Requests), optionally set
   `enforceAppCheck: true` on sensitive callables in `functions/index.js`.
Leaving the key blank is a safe no-op, so nothing breaks before you configure it.

### Session timeout / forced re-login (active on deploy — no setup)
`public/js/session.js` signs users out after **30 min idle** or **12 hr** since
sign-in, and periodically force-refreshes the ID token so a revoked session is
caught. Adjust the limits at the top of that file.

### Privacy / Terms / data rights (needs content review)
- `public/privacy.html` and `public/terms.html` are live and linked in the
  footer. **Fill in every highlighted `[[placeholder]]`** (legal business name,
  address, contact email, governing state, effective date) and have counsel
  review them before launch.
- Signed-in members can export or delete their own data from
  `/profile.html` (backed by the `requestDataExport` / `deleteMyAccount`
  callables). No setup needed.
- SMS `STOP`/`START` opt-out is handled in `twilioInboundWebhook`; `sendSms`
  refuses opted-out contacts. Works once Twilio is configured.
- A cookie-consent banner (`public/js/consent-banner.js`) is included on
  `index`, `login`, and `signup`. Add the same
  `<script src="/js/consent-banner.js" defer></script>` tag to other public
  pages if you want it site-wide.

> Note: code provides the mechanisms for privacy compliance (CCPA/CPRA and other
> state laws, TCPA, CAN-SPAM). It does **not** constitute legal advice or certify
> compliance — confirm with qualified counsel.

## Data model (for reference)

```
users/{uid}                   { email, displayName, role, companyId|null, tier, createdAt, lastActiveAt, currentModule }
users/{uid}/progress/{id}     { completed, completedAt, notes, noteSlots }
users/{uid}/capstone/...      { reflection, recordingUrl, submittedAt, reviewStatus }
companies/{companyId}         { name, adminUids[], seatCount, seatsUsed, tier, createdAt }
companies/{companyId}/invites/{code}  { email, code, status, companyId, createdAt, acceptedByUid }
```
