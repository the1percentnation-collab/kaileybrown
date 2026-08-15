# Kailey Brown

Public marketing site plus a login-protected member portal, on Firebase.

The platform lands here via pull request. See the open PR for the full build.

## Deploys

Three GitHub Actions workflows handle deployment, and they arrive with the
platform PR:

| Workflow | Trigger | Effect |
|---|---|---|
| `firebase-hosting-pull-request.yml` | PR opened or updated | Deploys a preview channel with its own temporary URL, posted as a PR comment |
| `firebase-hosting-merge.yml` | merge to `main` | Deploys hosting to production |
| `firebase-deploy-backend.yml` | merge to `main` touching rules, indexes or functions | Deploys security rules first and alone, then Cloud Functions |

So the loop is: open a PR, review the preview URL, merge to go live.

## Required repository secret

`FIREBASE_SERVICE_ACCOUNT_KAILEY_BROWN` — the service-account JSON from the
Firebase console under Project settings → Service accounts.

Set it at Settings → Secrets and variables → Actions → New repository secret.
Without it every deploy fails at the authentication step.

## Firebase project

`kaileybrown-48e22` (project number `192030174948`), on the Blaze plan, which
Cloud Functions v2 requires.
