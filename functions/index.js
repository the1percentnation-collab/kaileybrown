// Cloud Functions v2 — callable endpoints + Firestore triggers + HTTP webhook.
//
// First deployed after the service account was granted Service Usage Consumer
// and the deploy roles; earlier attempts failed on a serviceusage 403.
// Includes SendGrid email features: transactional emails (invite, welcome),
// 1-on-1 contact emails, campaign broadcast, and the SendGrid Event Webhook.
//
// Deploy: `npx firebase-tools deploy --only functions --project kaileybrown-48e22`

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const OWNER_EMAIL = 'kailey@kaileybrown.com';

// SendGrid identity
const FROM_EMAIL = 'kailey@kaileybrown.com';
const FROM_NAME_DEFAULT = 'Kailey Brown';
const REPLY_TO = 'kailey@kaileybrown.com';
// The custom domain, not the raw Firebase one. This lands in outbound email —
// company invites, notification deep links — where the .web.app host reads as a
// different, untrustworthy site next to the Kailey Brown branding around
// it. Both hosts serve the same app, so either works; only one looks right.
// (Member referral links don't rely on this: the client builds those from
// location.origin so they always carry whatever domain the member is on.)
const APP_BASE_URL = 'https://kaileybrown.com';

// Member referral scoring. Deliberately modest against the level curve in the
// Phase 2 block (level 5 = 400 points): at 10 points a referral is worth two
// posts, so the leaderboard keeps measuring participation rather than contact
// list size. Raise with care — this number is what decides whether the
// community's top ranks are earned by showing up or by mass-inviting.
const REFERRAL_POINTS = 10;

// Secret: SendGrid API key. Webhook verification key is optional and read
// lazily at runtime via the Secret Manager client — this avoids requiring
// SENDGRID_WEBHOOK_KEY to exist at deploy time.
//
// NOTE: `defineSecret` is different — it is resolved by the CLI at DEPLOY time,
// so every functions deploy calls secretmanager.googleapis.com. That API needs
// billing enabled, which makes an active Blaze plan a hard prerequisite for
// deploying at all, not just for running v2 functions. When billing lapsed in
// June 2026 this was the exact failure: `403 ... requires billing to be
// enabled` on SENDGRID_API_KEY, aborting the deploy. It used to take the
// Firestore rules deploy down with it until the workflow was split — see
// .github/workflows/firebase-deploy-backend.yml.
const sendgridKey = defineSecret('SENDGRID_API_KEY');

// Anthropic API key — read from runtime environment so deploys never block
// waiting for a secret value. Set via Firebase Console > Functions > Runtime
// environment variables, or `firebase functions:secrets:set ANTHROPIC_API_KEY`
// (then also add it to the onCall secrets array below).
const ANTHROPIC_API_KEY = () => (process.env.ANTHROPIC_API_KEY || '').trim();

// Twilio SMS credentials are read from process.env (like Stripe), NOT via
// defineSecret — so deploys succeed before the values exist. Until they're set
// (functions/.env or runtime env), sendSms returns "not configured" and the
// inbound webhook rejects unsigned traffic. Provide: TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
let _twilioClient = null;
function getTwilio() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token) return null;
  if (!_twilioClient) _twilioClient = require('twilio')(sid, token);
  return _twilioClient;
}

// Best-effort E.164 normalization (defaults to US +1 for 10-digit numbers).
function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s[0] !== '+') {
    const digits = s.replace(/\D/g, '');
    s = digits.length === 10 ? '+1' + digits : '+' + digits;
  }
  return s;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function textToHtml(text) {
  if (!text) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br/>');
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

async function assertCompanyAdmin(db, companyId, request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const companySnap = await db.collection('companies').doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError('not-found', 'Company not found.');
  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
  const adminUids = (companySnap.data() && companySnap.data().adminUids) || [];
  if (!isOwnerClaim && !adminUids.includes(uid)) {
    throw new HttpsError('permission-denied', 'Not an admin of this company.');
  }
  return { uid, isOwner: !!isOwnerClaim, company: companySnap.data() };
}

// ────────────────────────────────────────────────────────────────
// Rate limiting
// ────────────────────────────────────────────────────────────────
// Firestore-backed fixed-window limiter. Each caller (uid, or client IP for
// unauthenticated endpoints) gets a counter document per action, bucketed into
// a time window. When the count exceeds `max` inside `windowSec`, the call is
// rejected with resource-exhausted. This bounds abuse of expensive endpoints
// (AI calls, email/SMS sends, checkout, invite creation) without any external
// dependency. Counters are best-effort: if the transaction itself errors we
// fail OPEN (allow the call) so a Firestore hiccup never hard-locks the app.
//
// Note: this is a per-instance-agnostic, durable limiter — it counts across all
// function instances because the state lives in Firestore, not memory.
function clientIp(request) {
  // onCall exposes the raw request on request.rawRequest (Express req).
  const raw = request && request.rawRequest;
  if (!raw) return 'unknown';
  const fwd = (raw.headers && (raw.headers['x-forwarded-for'] || raw.headers['X-Forwarded-For'])) || '';
  if (fwd) return String(fwd).split(',')[0].trim();
  return (raw.ip || (raw.connection && raw.connection.remoteAddress) || 'unknown');
}

/**
 * enforceRateLimit(db, { action, key, max, windowSec })
 *  - action: logical bucket name, e.g. 'courseAdvisorChat'
 *  - key:    stable caller id (uid or ip). Combined with action + window.
 *  - max:    max allowed calls within the window
 *  - windowSec: window length in seconds
 * Throws HttpsError('resource-exhausted', ...) when the limit is exceeded.
 */
async function enforceRateLimit(db, { action, key, max, windowSec }) {
  if (!action || !key) return; // nothing to key on — allow.
  // Bucket boundary: current time floored to the window. Using seconds keeps the
  // doc id short and rotates buckets automatically (old buckets are simply
  // never read again; a scheduled cleanup can prune them later if desired).
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / windowSec);
  const safeKey = String(key).replace(/[^A-Za-z0-9_.@:-]/g, '_').slice(0, 200);
  const docId = `${action}__${safeKey}__${bucket}`;
  const ref = db.collection('rateLimits').doc(docId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? Number(snap.data().count || 0) : 0;
      if (count >= max) {
        throw new HttpsError('resource-exhausted',
          'Too many requests. Please slow down and try again in a minute.');
      }
      tx.set(ref, {
        count: count + 1,
        action,
        key: safeKey,
        // Expiry hint so a TTL policy (rateLimits.expiresAt) can auto-prune.
        expiresAt: admin.firestore.Timestamp.fromMillis((bucket + 2) * windowSec * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
  } catch (e) {
    // Re-throw our own limit error; swallow infrastructure errors (fail open).
    if (e instanceof HttpsError) throw e;
    console.warn('[rateLimit] counter write failed (failing open):', e && e.message);
  }
}

// Convenience: rate-limit by uid when signed in, else by client IP. Returns the
// key used (handy for logging). Call at the top of a handler, after you know
// whether auth is required.
async function rateLimitCaller(db, request, { action, max, windowSec }) {
  const uid = request.auth && request.auth.uid;
  const key = uid ? `uid:${uid}` : `ip:${clientIp(request)}`;
  await enforceRateLimit(db, { action, key, max, windowSec });
  return key;
}

/**
 * acceptInvite({ code })
 */
exports.acceptInvite = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const code = (request.data && request.data.code || '').toString().trim();
  if (!code) throw new HttpsError('invalid-argument', 'Missing invite code.');

  const db = admin.firestore();

  const snap = await db.collectionGroup('invites')
    .where('code', '==', code)
    .limit(1)
    .get();

  if (snap.empty) throw new HttpsError('not-found', 'Invite code not found.');
  const inviteRef = snap.docs[0].ref;
  const invite = snap.docs[0].data();
  if (invite.status && invite.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invite is ${invite.status}.`);
  }

  const companyId = invite.companyId || inviteRef.parent.parent.id;
  const companyRef = db.collection('companies').doc(companyId);
  const userRef = db.collection('users').doc(uid);

  await db.runTransaction(async (tx) => {
    const [companySnap, userSnap, inviteSnap] = await Promise.all([
      tx.get(companyRef),
      tx.get(userRef),
      tx.get(inviteRef)
    ]);
    if (!companySnap.exists) throw new HttpsError('not-found', 'Company not found.');
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invite not found.');
    const c = companySnap.data();
    const i = inviteSnap.data();

    if (i.status && i.status !== 'pending') {
      throw new HttpsError('failed-precondition', `Invite is ${i.status}.`);
    }
    const seatCount = Number(c.seatCount || 0);
    const seatsUsed = Number(c.seatsUsed || 0);
    if (seatsUsed >= seatCount) {
      throw new HttpsError('resource-exhausted', 'No seats remaining.');
    }

    tx.update(inviteRef, {
      status: 'accepted',
      acceptedByUid: uid,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.update(companyRef, {
      seatsUsed: seatsUsed + 1
    });

    const email = (request.auth.token && request.auth.token.email) || null;
    const displayName = (request.auth.token && request.auth.token.name) || null;
    const userPatch = {
      companyId,
      role: userSnap.exists && userSnap.data().role === 'owner' ? 'owner' : 'user',
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (!userSnap.exists) {
      userPatch.email = email;
      userPatch.displayName = displayName;
      userPatch.tier = 'team';
      userPatch.createdAt = admin.firestore.FieldValue.serverTimestamp();
      tx.set(userRef, userPatch);
    } else {
      tx.set(userRef, userPatch, { merge: true });
    }

    const memberRef = companyRef.collection('members').doc(uid);
    tx.set(memberRef, {
      uid,
      email: email || (userSnap.exists ? userSnap.data().email : null),
      displayName: displayName || (userSnap.exists ? userSnap.data().displayName : null),
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { ok: true, companyId };
});

/**
 * deleteContact({ companyId, contactId })
 */
exports.deleteContact = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const companyId = (request.data && request.data.companyId || '').toString().trim();
  const contactId = (request.data && request.data.contactId || '').toString().trim();
  if (!companyId || !contactId) {
    throw new HttpsError('invalid-argument', 'companyId and contactId are required.');
  }

  const db = admin.firestore();
  await assertCompanyAdmin(db, companyId, request);
  const companyRef = db.collection('companies').doc(companyId);

  const contactRef = companyRef.collection('contacts').doc(contactId);
  const contactSnap = await contactRef.get();
  if (!contactSnap.exists) {
    return { ok: true, deleted: 0, note: 'Contact already gone.' };
  }

  async function deleteCollection(colRef) {
    let deleted = 0;
    while (true) {
      const snap = await colRef.limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }
    return deleted;
  }

  const notesDeleted = await deleteCollection(contactRef.collection('notes'));
  const actsDeleted = await deleteCollection(contactRef.collection('activities'));
  await contactRef.delete();

  return { ok: true, deleted: notesDeleted + actsDeleted + 1 };
});

/**
 * deleteUser({ uid })
 *
 * Fully removes a user from the platform — Firestore user doc + subcollections
 * (progress, capstone, enrollments) + Firebase Auth account + company roster
 * entry. Decrements the company's seatsUsed and strips the user from adminUids.
 *
 * Permission: caller must be the bootstrap owner (custom claim role=owner), or
 * an admin of the target user's company (uid in companies/{cid}.adminUids).
 *
 * Refuses to delete self or the bootstrap owner account.
 */
exports.deleteUser = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const targetUid = (request.data && request.data.uid || '').toString().trim();
  if (!targetUid) throw new HttpsError('invalid-argument', 'Target uid is required.');

  if (callerUid === targetUid) {
    throw new HttpsError('failed-precondition', 'Cannot delete your own account here.');
  }

  const db = admin.firestore();
  const targetUserRef = db.collection('users').doc(targetUid);
  const targetUserSnap = await targetUserRef.get();

  // If the user doc is already gone, still try to clean up Auth as a best-effort.
  if (!targetUserSnap.exists) {
    const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
    if (!isOwnerClaim) {
      throw new HttpsError('permission-denied', 'User not found and caller is not owner.');
    }
    try { await admin.auth().deleteUser(targetUid); } catch (e) {}
    return { ok: true, deleted: 0, note: 'User doc already gone.' };
  }

  const targetData = targetUserSnap.data() || {};
  const targetCompanyId = targetData.companyId || null;
  const targetEmail = (targetData.email || '').toLowerCase();

  if (targetEmail === OWNER_EMAIL.toLowerCase()) {
    throw new HttpsError('failed-precondition', 'Cannot delete the bootstrap owner account.');
  }

  // Permission: owner OR admin of the target's company.
  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
  let isCompanyAdmin = false;
  if (!isOwnerClaim && targetCompanyId) {
    const compSnap = await db.collection('companies').doc(targetCompanyId).get();
    if (compSnap.exists) {
      const adminUids = (compSnap.data() && compSnap.data().adminUids) || [];
      isCompanyAdmin = adminUids.includes(callerUid);
    }
  }
  if (!isOwnerClaim && !isCompanyAdmin) {
    throw new HttpsError('permission-denied', 'You do not have permission to delete this user.');
  }

  async function deleteCollection(colRef) {
    let deleted = 0;
    while (true) {
      const snap = await colRef.limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }
    return deleted;
  }

  const progressDeleted = await deleteCollection(targetUserRef.collection('progress'));
  const capstoneDeleted = await deleteCollection(targetUserRef.collection('capstone'));
  const enrollDeleted  = await deleteCollection(targetUserRef.collection('enrollments'));

  // Remove from company roster + decrement seat + strip from adminUids.
  if (targetCompanyId) {
    const companyRef = db.collection('companies').doc(targetCompanyId);
    const memberRef = companyRef.collection('members').doc(targetUid);
    try { await memberRef.delete(); } catch (e) { /* best-effort */ }
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(companyRef);
        if (!s.exists) return;
        const c = s.data() || {};
        const newUsed = Math.max(0, (c.seatsUsed || 0) - 1);
        const adminUids = (c.adminUids || []).filter((u) => u !== targetUid);
        tx.update(companyRef, { seatsUsed: newUsed, adminUids });
      });
    } catch (e) { /* best-effort */ }
  }

  await targetUserRef.delete();

  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e) {
    if (e && e.code !== 'auth/user-not-found') {
      console.warn('[deleteUser] auth.deleteUser failed:', e.message);
    }
  }

  return {
    ok: true,
    deleted: progressDeleted + capstoneDeleted + enrollDeleted + 1
  };
});

/**
 * deleteMyAccount() — self-service account + data deletion (CCPA/CPRA "right to
 * delete", and the equivalent right under the other state privacy laws).
 * The signed-in user erases their OWN account: user doc, all private
 * subcollections, company roster entry + seat, and the Firebase Auth user.
 *
 * The bootstrap owner cannot self-delete here (that would orphan the platform).
 */
exports.deleteMyAccount = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.exists ? (userSnap.data() || {}) : {};
  const email = (data.email || (request.auth.token && request.auth.token.email) || '').toLowerCase();

  if (email && email === OWNER_EMAIL.toLowerCase()) {
    throw new HttpsError('failed-precondition',
      'The owner account cannot be self-deleted. Contact support to transfer ownership first.');
  }

  // Wipe every per-user subcollection that holds their data.
  async function deleteCollection(colRef) {
    let deleted = 0;
    while (true) {
      const snap = await colRef.limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }
    return deleted;
  }
  const subcollections = ['progress', 'capstone', 'enrollments', 'notifications',
    'registrations', 'courseInterests', 'purchases', 'stats'];
  for (const name of subcollections) {
    try { await deleteCollection(userRef.collection(name)); } catch (e) { /* best-effort */ }
  }

  // Remove from company roster, free the seat, strip any admin grant.
  const companyId = data.companyId || null;
  if (companyId) {
    const companyRef = db.collection('companies').doc(companyId);
    try { await companyRef.collection('members').doc(uid).delete(); } catch (e) { /* best-effort */ }
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(companyRef);
        if (!s.exists) return;
        const c = s.data() || {};
        const newUsed = Math.max(0, (c.seatsUsed || 0) - 1);
        const adminUids = (c.adminUids || []).filter((u) => u !== uid);
        tx.update(companyRef, { seatsUsed: newUsed, adminUids });
      });
    } catch (e) { /* best-effort */ }
  }

  try { await userRef.delete(); } catch (e) { /* best-effort */ }
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e && e.code !== 'auth/user-not-found') {
      console.warn('[deleteMyAccount] auth.deleteUser failed:', e.message);
    }
  }

  return { ok: true };
});

/**
 * requestDataExport() — self-service data access/portability (CCPA/CPRA "right
 * to know", GDPR-style portability). Returns the signed-in user's own profile
 * doc plus their private subcollections as a plain JSON object the client can
 * download. No PII of anyone else is included.
 */
exports.requestDataExport = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  await rateLimitCaller(admin.firestore(), request,
    { action: 'requestDataExport', max: 5, windowSec: 3600 });

  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'No account data found.');

  // Firestore Timestamps -> ISO strings so the JSON is portable/readable.
  function serialize(obj) {
    if (obj == null) return obj;
    if (obj && typeof obj.toDate === 'function') return obj.toDate().toISOString();
    if (Array.isArray(obj)) return obj.map(serialize);
    if (typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = serialize(v);
      return out;
    }
    return obj;
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    uid,
    profile: serialize(userSnap.data()),
    collections: {}
  };

  const subcollections = ['progress', 'capstone', 'enrollments', 'notifications',
    'registrations', 'courseInterests', 'purchases', 'stats'];
  for (const name of subcollections) {
    try {
      const snap = await userRef.collection(name).get();
      if (!snap.empty) {
        exportData.collections[name] = snap.docs.map((d) => ({ id: d.id, ...serialize(d.data()) }));
      }
    } catch (e) { /* best-effort */ }
  }

  return { ok: true, data: exportData };
});

/**
 * bootstrapOwner()
 */
exports.bootstrapOwner = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const email = (request.auth.token && request.auth.token.email || '').toLowerCase();
  if (email !== OWNER_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the bootstrap owner email can claim ownership.');
  }
  await admin.auth().setCustomUserClaims(uid, { role: 'owner' });
  await admin.firestore().collection('users').doc(uid).set({
    email,
    role: 'owner',
    lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, note: 'Sign out and back in (or refresh token) for the claim to take effect.' };
});

// ────────────────────────────────────────────────────────────────
// Email: invite on create
// ────────────────────────────────────────────────────────────────

/**
 * onInviteCreated — Firestore trigger on companies/{companyId}/invites/{inviteId}.
 * Sends an invite email via SendGrid and records emailStatus on the invite doc.
 */
exports.onInviteCreated = onDocumentCreated(
  { document: 'companies/{companyId}/invites/{inviteId}', secrets: [sendgridKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const invite = snap.data();
    const companyId = event.params.companyId;

    if (!invite || !invite.email) {
      try { await snap.ref.update({ emailStatus: 'skipped', emailError: 'No recipient email' }); } catch (e) {}
      return;
    }

    try {
      sgMail.setApiKey(sendgridKey.value());

      let companyName = 'the team';
      try {
        const cSnap = await admin.firestore().collection('companies').doc(companyId).get();
        if (cSnap.exists) companyName = cSnap.data().name || companyName;
      } catch (e) {}

      const code = invite.code || snap.id;
      const link = `${APP_BASE_URL}/invite.html?code=${encodeURIComponent(code)}`;

      const subject = `You're invited to join ${companyName} on Kailey Brown`;
      const textBody =
        `You've been invited to join ${companyName} on the Kailey Brown portal.\n\n` +
        `Click the link below to accept your invite and get started:\n${link}\n\n` +
        `If the link doesn't work, paste it into your browser.\n\n— Kailey Brown`;

      const htmlBody = `
        <div style="font-family:Arial,sans-serif;color:#3C3C3C;max-width:560px;margin:0 auto;">
          <h2 style="color:#C8102E;margin-bottom:8px;">Welcome to Kailey Brown</h2>
          <p>You've been invited to join <strong>${companyName}</strong> on the Kailey Brown portal.</p>
          <p><a href="${link}" style="display:inline-block;background:#C8102E;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600;">Accept invite</a></p>
          <p style="color:#8A8A8A;font-size:12px;">Or paste this link into your browser:<br/><a href="${link}">${link}</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
          <p style="color:#8A8A8A;font-size:11px;">Kailey Brown</p>
        </div>`;

      const [resp] = await sgMail.send({
        to: invite.email,
        from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
        replyTo: REPLY_TO,
        subject,
        text: textBody,
        html: htmlBody,
        customArgs: {
          type: 'invite',
          companyId,
          inviteId: snap.id
        }
      });

      const messageId = resp && resp.headers && resp.headers['x-message-id'] || null;

      await snap.ref.update({
        emailStatus: 'sent',
        emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
        emailMessageId: messageId
      });
    } catch (err) {
      console.error('[onInviteCreated] send failed:', err && err.message);
      try {
        await snap.ref.update({
          emailStatus: 'failed',
          emailError: String((err && err.message) || err).slice(0, 500)
        });
      } catch (e2) {}
    }
  }
);

// ────────────────────────────────────────────────────────────────
// Email: welcome on user create
// ────────────────────────────────────────────────────────────────

exports.onUserCreated = onDocumentCreated(
  { document: 'users/{uid}', secrets: [sendgridKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const user = snap.data();
    if (!user || !user.email) return;

    try {
      sgMail.setApiKey(sendgridKey.value());

      let companyName = null;
      if (user.companyId) {
        try {
          const cSnap = await admin.firestore().collection('companies').doc(user.companyId).get();
          if (cSnap.exists) companyName = cSnap.data().name || null;
        } catch (e) {}
      }

      const firstName = (user.displayName || '').split(' ')[0] || 'there';
      const companyLine = companyName
        ? `You're now part of <strong>${companyName}</strong>.`
        : `Your account is ready.`;
      const companyLineText = companyName
        ? `You're now part of ${companyName}.`
        : `Your account is ready.`;

      const subject = 'Welcome to Kailey Brown';
      const textBody =
        `Hi ${firstName},\n\n` +
        `Welcome to the Kailey Brown portal. ${companyLineText}\n\n` +
        `Jump into the community feed: ${APP_BASE_URL}/community.html\n` +
        `Or start your coursework: ${APP_BASE_URL}/index.html\n\n` +
        `— Kailey Brown`;

      const htmlBody = `
        <div style="font-family:Arial,sans-serif;color:#3C3C3C;max-width:560px;margin:0 auto;">
          <h2 style="color:#C8102E;margin-bottom:8px;">Welcome, ${firstName}.</h2>
          <p>${companyLine}</p>
          <p style="margin:20px 0;">
            <a href="${APP_BASE_URL}/community.html" style="display:inline-block;background:#C8102E;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:600;margin-right:8px;">Community feed</a>
            <a href="${APP_BASE_URL}/index.html" style="display:inline-block;background:#1A1A1A;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:600;">Start coursework</a>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
          <p style="color:#8A8A8A;font-size:11px;">Kailey Brown</p>
        </div>`;

      await sgMail.send({
        to: user.email,
        from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
        replyTo: REPLY_TO,
        subject,
        text: textBody,
        html: htmlBody,
        customArgs: {
          type: 'welcome',
          uid: snap.id
        }
      });
    } catch (err) {
      console.error('[onUserCreated] welcome send failed:', err && err.message);
    }
  }
);

// ────────────────────────────────────────────────────────────────
// sendContactEmail — callable
// ────────────────────────────────────────────────────────────────

exports.sendContactEmail = onCall(
  { secrets: [sendgridKey] },
  async (request) => {
    const db = admin.firestore();
    const data = request.data || {};
    const companyId = (data.companyId || '').toString().trim();
    const contactId = (data.contactId || '').toString().trim();
    const subject = (data.subject || '').toString().trim();
    const bodyHtml = (data.bodyHtml || '').toString();
    const bodyText = (data.bodyText || '').toString();

    if (!companyId || !contactId) throw new HttpsError('invalid-argument', 'companyId and contactId are required.');
    if (!subject) throw new HttpsError('invalid-argument', 'Subject is required.');
    if (!bodyHtml && !bodyText) throw new HttpsError('invalid-argument', 'Body is required.');

    const { uid } = await assertCompanyAdmin(db, companyId, request);

    // Throttle single-contact sends: 60 per admin per 10 minutes.
    await rateLimitCaller(db, request, { action: 'sendContactEmail', max: 60, windowSec: 600 });

    const contactRef = db.collection('companies').doc(companyId).collection('contacts').doc(contactId);
    const contactSnap = await contactRef.get();
    if (!contactSnap.exists) throw new HttpsError('not-found', 'Contact not found.');
    const contact = contactSnap.data();
    if (!contact.email) throw new HttpsError('failed-precondition', 'Contact has no email address.');

    const finalText = bodyText || htmlToText(bodyHtml);
    const finalHtml = bodyHtml || textToHtml(bodyText);

    sgMail.setApiKey(sendgridKey.value());

    let messageId = null;
    try {
      const [resp] = await sgMail.send({
        to: contact.email,
        from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
        replyTo: REPLY_TO,
        subject,
        text: finalText,
        html: finalHtml,
        customArgs: {
          type: 'contact',
          companyId,
          contactId
        }
      });
      messageId = resp && resp.headers && resp.headers['x-message-id'] || null;
    } catch (err) {
      console.error('[sendContactEmail] failed:', err && err.message);
      throw new HttpsError('internal', 'SendGrid rejected the send: ' + ((err && err.message) || 'unknown'));
    }

    // Actor name lookup
    let actorName = (request.auth.token && request.auth.token.name) || null;
    if (!actorName) {
      try {
        const uSnap = await db.collection('users').doc(uid).get();
        if (uSnap.exists) actorName = uSnap.data().displayName || uSnap.data().email || null;
      } catch (e) {}
    }
    if (!actorName) actorName = (request.auth.token && request.auth.token.email) || 'Unknown';

    const bodyPreview = finalText.length > 200 ? finalText.slice(0, 200) + '…' : finalText;
    const desc = subject.length > 80 ? subject.slice(0, 80) + '…' : subject;

    try {
      await contactRef.collection('activities').add({
        type: 'email_sent',
        description: desc,
        actorUid: uid,
        actorName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        meta: { subject, bodyPreview, messageId }
      });
      await contactRef.update({
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.warn('[sendContactEmail] activity log failed:', e && e.message);
    }

    return { ok: true, messageId };
  }
);

// ────────────────────────────────────────────────────────────────
// sendCampaign — callable
// ────────────────────────────────────────────────────────────────

async function buildRecipients(db, companyId, filter) {
  const mode = (filter && filter.mode) || 'all_contacts';
  const seen = new Set();
  const recipients = []; // { email, name?, firstName? }

  function push(email, name) {
    if (!email) return;
    const e = String(email).trim().toLowerCase();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || seen.has(e)) return;
    seen.add(e);
    const firstName = name ? String(name).split(' ')[0] : '';
    recipients.push({ email: e, name: name || '', firstName });
  }

  if (mode === 'all_users') {
    // Members of the company.
    const snap = await db.collection('companies').doc(companyId).collection('members').get();
    snap.docs.forEach((d) => {
      const m = d.data();
      push(m.email, m.displayName);
    });
    return recipients;
  }

  // Contact-based modes.
  const colRef = db.collection('companies').doc(companyId).collection('contacts');
  let rows = [];

  if (mode === 'stages' && Array.isArray(filter.stages) && filter.stages.length) {
    // Firestore `in` supports up to 10 values. Chunk.
    const chunks = [];
    for (let i = 0; i < filter.stages.length; i += 10) chunks.push(filter.stages.slice(i, i + 10));
    for (const chunk of chunks) {
      const snap = await colRef.where('stage', 'in', chunk).get();
      snap.docs.forEach((d) => rows.push(d.data()));
    }
  } else if (mode === 'tags' && Array.isArray(filter.tags) && filter.tags.length) {
    const chunks = [];
    for (let i = 0; i < filter.tags.length; i += 10) chunks.push(filter.tags.slice(i, i + 10));
    for (const chunk of chunks) {
      const snap = await colRef.where('tags', 'array-contains-any', chunk).get();
      snap.docs.forEach((d) => rows.push(d.data()));
    }
  } else if (mode === 'owner' && filter.ownerUid) {
    const snap = await colRef.where('ownerUid', '==', filter.ownerUid).get();
    snap.docs.forEach((d) => rows.push(d.data()));
  } else {
    // all_contacts
    const snap = await colRef.get();
    snap.docs.forEach((d) => rows.push(d.data()));
  }

  rows.forEach((c) => push(c.email, c.name));
  return recipients;
}

exports.sendCampaign = onCall(
  { secrets: [sendgridKey], timeoutSeconds: 540 },
  async (request) => {
    const db = admin.firestore();
    const data = request.data || {};
    const companyId = (data.companyId || '').toString().trim();
    const campaignId = (data.campaignId || '').toString().trim();
    if (!companyId || !campaignId) throw new HttpsError('invalid-argument', 'companyId and campaignId are required.');

    await assertCompanyAdmin(db, companyId, request);

    // Throttle broadcast sends: 10 campaign dispatches per admin per hour.
    await rateLimitCaller(db, request, { action: 'sendCampaign', max: 10, windowSec: 3600 });

    const campaignRef = db.collection('companies').doc(companyId).collection('campaigns').doc(campaignId);
    const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) throw new HttpsError('not-found', 'Campaign not found.');
    const campaign = campaignSnap.data();
    const status = campaign.status || 'draft';
    if (!['draft', 'ready'].includes(status)) {
      throw new HttpsError('failed-precondition', `Cannot send a campaign with status "${status}".`);
    }

    const subject = (campaign.subject || '').toString().trim();
    if (!subject) throw new HttpsError('invalid-argument', 'Campaign has no subject.');
    const bodyText = campaign.bodyText || '';
    const bodyHtml = campaign.bodyHtml || textToHtml(bodyText);
    const finalText = bodyText || htmlToText(bodyHtml);
    const fromName = campaign.fromName || FROM_NAME_DEFAULT;

    await campaignRef.update({
      status: 'sending',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    let recipients = [];
    try {
      recipients = await buildRecipients(db, companyId, campaign.recipientFilter || { mode: 'all_contacts' });
    } catch (err) {
      await campaignRef.update({
        status: 'failed',
        errorSample: [String((err && err.message) || err).slice(0, 300)],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      throw new HttpsError('internal', 'Could not build recipient list: ' + ((err && err.message) || 'unknown'));
    }

    if (!recipients.length) {
      await campaignRef.update({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        recipientCount: 0,
        acceptedCount: 0,
        failedCount: 0,
        errorSample: [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true, recipientCount: 0, acceptedCount: 0, failedCount: 0 };
    }

    sgMail.setApiKey(sendgridKey.value());

    let accepted = 0;
    let failed = 0;
    const errorSample = [];

    // Chunk into batches of 1000.
    const BATCH_SIZE = 1000;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const chunk = recipients.slice(i, i + BATCH_SIZE);
      const personalizations = chunk.map((r) => {
        const personalizedSubject = subject.replace(/\{\{\s*firstName\s*\}\}/g, r.firstName || '');
        return {
          to: [{ email: r.email, name: r.name || undefined }],
          subject: personalizedSubject,
          customArgs: {
            type: 'campaign',
            companyId,
            campaignId,
            recipientEmail: r.email
          }
        };
      });

      const htmlPersonalized = bodyHtml; // No per-recipient token substitution beyond subject (kept simple per spec).
      const textPersonalized = finalText;

      const msg = {
        from: { email: FROM_EMAIL, name: fromName },
        replyTo: REPLY_TO,
        subject, // fallback; personalizations override per-message
        text: textPersonalized,
        html: htmlPersonalized,
        personalizations,
        customArgs: {
          type: 'campaign',
          companyId,
          campaignId
        }
      };

      try {
        await sgMail.send(msg);
        accepted += chunk.length;
      } catch (err) {
        failed += chunk.length;
        const msgStr = String((err && err.message) || err).slice(0, 300);
        if (errorSample.length < 5) errorSample.push(msgStr);
        console.error('[sendCampaign] batch send failed:', msgStr);
      }
    }

    await campaignRef.update({
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      recipientCount: recipients.length,
      acceptedCount: accepted,
      failedCount: failed,
      errorSample,
      stats: {
        delivered: admin.firestore.FieldValue.increment(0),
        opens: admin.firestore.FieldValue.increment(0),
        clicks: admin.firestore.FieldValue.increment(0),
        bounces: admin.firestore.FieldValue.increment(0),
        unsubs: admin.firestore.FieldValue.increment(0)
      }
    });

    // Initialize stats if they don't exist.
    try {
      const latest = (await campaignRef.get()).data() || {};
      if (!latest.stats || typeof latest.stats !== 'object' || Object.keys(latest.stats).length === 0) {
        await campaignRef.update({
          stats: { delivered: 0, opens: 0, clicks: 0, bounces: 0, unsubs: 0 }
        });
      }
    } catch (e) {}

    return { ok: true, recipientCount: recipients.length, acceptedCount: accepted, failedCount: failed };
  }
);

// ────────────────────────────────────────────────────────────────
// shareEventToContacts — callable. Emails a community event to CRM
// contacts (or company members) using the same recipient-filter modes
// as sendCampaign. Reads the event from the top-level events/ collection.
// ────────────────────────────────────────────────────────────────

function eventEmail(event, baseUrl, customMessage) {
  const title = (event.title || 'Event').toString();
  const toDate = (t) => (t && typeof t.toDate === 'function') ? t.toDate() : (t ? new Date(t) : null);
  const start = toDate(event.startsAt);
  const end = toDate(event.endsAt);
  let when = 'Date to be announced';
  if (start && !isNaN(start.getTime())) {
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    when = start.toLocaleString('en-US', opts);
    if (end && !isNaN(end.getTime())) {
      const sameDay = end.toDateString() === start.toDateString();
      when += ' – ' + (sameDay
        ? end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
        : end.toLocaleString('en-US', opts));
    }
  }
  const esc = (s) => textToHtml(s);
  const link = event.link || `${baseUrl}/events`;
  const ctaLabel = event.link ? 'Join the event' : 'View event details';

  const textParts = [];
  if (customMessage) textParts.push(customMessage, '');
  textParts.push(`You're invited: ${title}`, '', when);
  if (event.location) textParts.push(`Location: ${event.location}`);
  if (event.hostName) textParts.push(`Hosted by ${event.hostName}`);
  if (event.description) textParts.push('', event.description);
  textParts.push('', `${ctaLabel}: ${link}`);
  const text = textParts.join('\n');

  const img = event.imageUrl
    ? `<img src="${event.imageUrl}" alt="" style="width:100%;max-width:560px;border-radius:10px;display:block;margin:0 0 20px;" />`
    : '';
  const customHtml = customMessage ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;">${esc(customMessage)}</p>` : '';
  const descHtml = event.description ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#444;">${esc(event.description)}</p>` : '';
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:8px;">
      <p style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#C8102E;margin:0 0 6px;">You're invited</p>
      ${customHtml}
      ${img}
      <h1 style="font-size:22px;margin:0 0 12px;color:#111;">${esc(title)}</h1>
      <p style="margin:0 0 6px;font-size:15px;color:#222;">🗓️ ${esc(when)}</p>
      ${event.location ? `<p style="margin:0 0 6px;font-size:15px;color:#222;">📍 ${esc(event.location)}</p>` : ''}
      ${event.hostName ? `<p style="margin:0 0 6px;font-size:14px;color:#666;">Hosted by ${esc(event.hostName)}</p>` : ''}
      ${descHtml}
      <p style="margin:24px 0 0;">
        <a href="${link}" style="background:#C8102E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block;">${ctaLabel} →</a>
      </p>
    </div>
  `;
  return { subject: `You're invited: ${title}`, text, html };
}

exports.shareEventToContacts = onCall(
  { secrets: [sendgridKey], timeoutSeconds: 540 },
  async (request) => {
    const db = admin.firestore();
    const data = request.data || {};
    const companyId = (data.companyId || '').toString().trim();
    const eventId = (data.eventId || '').toString().trim();
    const customMessage = (data.message || '').toString().slice(0, 1000);
    const recipientFilter = data.recipientFilter || { mode: 'all_contacts' };
    if (!companyId || !eventId) throw new HttpsError('invalid-argument', 'companyId and eventId are required.');

    await assertCompanyAdmin(db, companyId, request);

    const eventSnap = await db.collection('events').doc(eventId).get();
    if (!eventSnap.exists) throw new HttpsError('not-found', 'Event not found.');
    const event = eventSnap.data();

    let recipients = [];
    try {
      recipients = await buildRecipients(db, companyId, recipientFilter);
    } catch (err) {
      throw new HttpsError('internal', 'Could not build recipient list: ' + ((err && err.message) || 'unknown'));
    }
    if (!recipients.length) return { ok: true, recipientCount: 0, acceptedCount: 0, failedCount: 0 };

    const { subject, text, html } = eventEmail(event, APP_BASE_URL, customMessage);

    sgMail.setApiKey(sendgridKey.value());
    let accepted = 0;
    let failed = 0;
    const errorSample = [];
    const BATCH_SIZE = 1000;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const chunk = recipients.slice(i, i + BATCH_SIZE);
      const personalizations = chunk.map((r) => ({
        to: [{ email: r.email, name: r.name || undefined }],
        customArgs: { type: 'event', companyId, eventId, recipientEmail: r.email }
      }));
      try {
        await sgMail.send({
          from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
          replyTo: REPLY_TO,
          subject,
          text,
          html,
          personalizations,
          customArgs: { type: 'event', companyId, eventId }
        });
        accepted += chunk.length;
      } catch (err) {
        failed += chunk.length;
        const msgStr = String((err && err.message) || err).slice(0, 300);
        if (errorSample.length < 5) errorSample.push(msgStr);
        console.error('[shareEventToContacts] batch send failed:', msgStr);
      }
    }

    return { ok: true, recipientCount: recipients.length, acceptedCount: accepted, failedCount: failed, errorSample };
  }
);

// ────────────────────────────────────────────────────────────────
// registerForEvent — callable (public, unauthenticated allowed). Records an
// event registration, upserts a CRM contact (source: Event), mirrors to the
// member's account when signed in, and bumps the event's registrationCount.
// ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function resolveEventCompanyId(db, event) {
  if (event.companyId) return event.companyId;
  const ownerUid = event.createdByUid || event.hostUid || null;
  if (ownerUid) {
    try {
      const uSnap = await db.collection('users').doc(ownerUid).get();
      if (uSnap.exists && uSnap.data().companyId) return uSnap.data().companyId;
    } catch (e) {}
    try {
      const snap = await db.collection('companies').where('adminUids', 'array-contains', ownerUid).limit(1).get();
      if (!snap.empty) return snap.docs[0].id;
    } catch (e) {}
  }
  return null;
}

async function upsertEventContact(db, companyId, event, name, email, ownerUid, extra) {
  const colRef = db.collection('companies').doc(companyId).collection('contacts');
  const tag = (event.title || '').toString().slice(0, 40);
  const phone = (extra && extra.phone) || null;
  const address = (extra && extra.address) || null;
  let contactRef = null;
  try {
    const snap = await colRef.where('email', '==', email).limit(1).get();
    if (!snap.empty) contactRef = snap.docs[0].ref;
  } catch (e) {}

  if (contactRef) {
    const patch = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (phone) patch.phone = phone;
    if (address) patch.address = address;
    if (tag) patch.tags = admin.firestore.FieldValue.arrayUnion(tag);
    await contactRef.set(patch, { merge: true });
  } else {
    contactRef = await colRef.add({
      name: name || 'Unnamed contact',
      email,
      phone: phone,
      address: address,
      companyName: null,
      source: 'Event',
      stage: 'new',
      tags: tag ? [tag] : [],
      ownerUid: ownerUid || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: 'system',
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  try {
    const notes = (extra && extra.notes) || null;
    await contactRef.collection('activities').add({
      type: 'event_registration',
      description: `Registered for "${(event.title || 'event').toString().slice(0, 80)}"` + (notes ? ` — Note: ${notes.slice(0, 200)}` : ''),
      actorUid: 'system',
      actorName: 'Event registration',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: { eventId: event.id || null, eventTitle: event.title || null, phone: phone || null, address: address || null, notes: notes || null }
    });
  } catch (e) {}
}

exports.registerForEvent = onCall(async (request) => {
  const db = admin.firestore();
  const data = request.data || {};
  const eventId = (data.eventId || '').toString().trim();
  const name = (data.name || '').toString().trim().slice(0, 120);
  const email = (data.email || '').toString().trim().toLowerCase().slice(0, 200);
  const phone = (data.phone || '').toString().trim().slice(0, 40);
  const address = (data.address || '').toString().trim().slice(0, 240);
  const notes = (data.notes || '').toString().trim().slice(0, 800);

  if (!eventId) throw new HttpsError('invalid-argument', 'eventId is required.');
  if (!name) throw new HttpsError('invalid-argument', 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email.');

  const uid = (request.auth && request.auth.uid) || null;

  const eventRef = db.collection('events').doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new HttpsError('not-found', 'Event not found.');
  const event = { id: eventId, ...eventSnap.data() };

  // Dedup key: uid for members, hashed email for the public.
  const regId = uid || ('e_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 24));
  const regRef = eventRef.collection('registrations').doc(regId);
  const existing = await regRef.get();
  const alreadyRegistered = existing.exists;

  await regRef.set({
    name,
    email,
    phone: phone || null,
    address: address || null,
    notes: notes || null,
    uid: uid || null,
    source: uid ? 'member' : 'public',
    registeredAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  if (!alreadyRegistered) {
    try { await eventRef.set({ registrationCount: admin.firestore.FieldValue.increment(1) }, { merge: true }); } catch (e) {}
  }

  // Upsert into the CRM (best-effort — registration still succeeds if no company).
  try {
    const companyId = await resolveEventCompanyId(db, event);
    if (companyId) {
      await upsertEventContact(db, companyId, event, name, email, event.createdByUid || event.hostUid || null, { phone, address, notes });
    }
  } catch (e) {
    console.warn('[registerForEvent] CRM upsert failed:', e && e.message);
  }

  // Mirror to the member's account so they see it as "Registered".
  if (uid) {
    try {
      await db.collection('users').doc(uid).collection('registrations').doc(eventId).set({
        eventId,
        title: event.title || null,
        startsAt: event.startsAt || null,
        registeredAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {}
  }

  let registrationCount = null;
  try { registrationCount = (await eventRef.get()).data().registrationCount || null; } catch (e) {}

  return { ok: true, alreadyRegistered, registrationCount };
});

// ────────────────────────────────────────────────────────────────
// Course interest + member onboarding → CRM
//
// Both callables upsert the caller into the academy's CRM (the owner's
// company) so admins/owners can see who signed up and what they want.
// They run with the Admin SDK, so they bypass Firestore rules — members
// never get direct write access to the contacts collection.
// ────────────────────────────────────────────────────────────────

// Resolve the academy's company (the owner's). Cached per cold start.
let _academyCompanyIdCache = null;
async function resolveAcademyCompanyId(db) {
  if (_academyCompanyIdCache) return _academyCompanyIdCache;
  // 1) Find the owner user, prefer their companyId.
  try {
    const snap = await db.collection('users').where('email', '==', OWNER_EMAIL).limit(1).get();
    if (!snap.empty) {
      const owner = snap.docs[0];
      const cid = owner.data().companyId;
      if (cid) { _academyCompanyIdCache = cid; return cid; }
      // 2) Else a company the owner administers.
      const cSnap = await db.collection('companies').where('adminUids', 'array-contains', owner.id).limit(1).get();
      if (!cSnap.empty) { _academyCompanyIdCache = cSnap.docs[0].id; return cSnap.docs[0].id; }
    }
  } catch (e) { console.warn('[resolveAcademyCompanyId]', e && e.message); }
  // 3) Fallback: the first company that exists.
  try {
    const any = await db.collection('companies').limit(1).get();
    if (!any.empty) { _academyCompanyIdCache = any.docs[0].id; return any.docs[0].id; }
  } catch (e) {}
  return null;
}

// Find-or-create a contact by email, merge fields, and return its ref.
async function upsertCrmContact(db, companyId, { name, email, phone, address, companyName, source, tags }) {
  const colRef = db.collection('companies').doc(companyId).collection('contacts');
  const FV = admin.firestore.FieldValue;
  let ref = null;
  try {
    const snap = await colRef.where('email', '==', email).limit(1).get();
    if (!snap.empty) ref = snap.docs[0].ref;
  } catch (e) {}

  if (ref) {
    const patch = { updatedAt: FV.serverTimestamp(), lastActivityAt: FV.serverTimestamp() };
    if (name) patch.name = name;
    if (phone) patch.phone = phone;
    if (address) patch.address = address;
    if (companyName) patch.companyName = companyName;
    if (tags && tags.length) patch.tags = FV.arrayUnion(...tags);
    await ref.set(patch, { merge: true });
  } else {
    ref = await colRef.add({
      name: name || 'Member',
      email,
      phone: phone || null,
      address: address || null,
      companyName: companyName || null,
      source: source || 'Member',
      stage: 'new',
      tags: tags || [],
      ownerUid: null,
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp(),
      createdBy: 'system',
      lastActivityAt: FV.serverTimestamp()
    });
  }
  return ref;
}

// registerCourseInterest({ slug, title }) — member taps "Notify me when live".
exports.registerCourseInterest = onCall(async (request) => {
  const db = admin.firestore();
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const slug = (data.slug || '').toString().trim().slice(0, 80);
  const title = (data.title || '').toString().trim().slice(0, 120) || slug;
  if (!slug) throw new HttpsError('invalid-argument', 'A course slug is required.');

  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : {};
  const email = (u.email || (request.auth.token && request.auth.token.email) || '').toString().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpsError('failed-precondition', 'Your account has no valid email.');

  const FV = admin.firestore.FieldValue;

  // Mirror to the member's own account (dedupes the button + lets them see it).
  await db.collection('users').doc(uid).collection('courseInterests').doc(slug).set({
    slug, title, createdAt: FV.serverTimestamp()
  }, { merge: true });

  // Upsert into the CRM (best-effort).
  try {
    const companyId = await resolveAcademyCompanyId(db);
    if (companyId) {
      const ref = await upsertCrmContact(db, companyId, {
        name: u.displayName || null,
        email,
        phone: u.phone || null,
        address: u.address || null,
        companyName: u.company || null,
        source: 'Course Interest',
        tags: [`Waitlist: ${title}`.slice(0, 40)]
      });
      await ref.collection('activities').add({
        type: 'course_interest',
        description: `Joined the waitlist for "${title}"`,
        actorUid: 'system',
        actorName: 'Course waitlist',
        createdAt: FV.serverTimestamp(),
        meta: { courseSlug: slug, courseTitle: title }
      });
    }
  } catch (e) {
    console.warn('[registerCourseInterest] CRM upsert failed:', e && e.message);
  }

  return { ok: true, slug };
});

// submitOnboarding({ displayName, phone, address, company, industry, location, goals })
// Required after member-portal signup. Updates the user profile and upserts
// the member into the CRM with everything they entered.
exports.submitOnboarding = onCall(async (request) => {
  const db = admin.firestore();
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const s = (v, n) => (v || '').toString().trim().slice(0, n);
  const displayName = s(data.displayName, 120);
  const phone = s(data.phone, 40);
  const address = s(data.address, 240);
  const company = s(data.company, 120);
  const industry = s(data.industry, 80);
  const location = s(data.location, 120);
  const goals = s(data.goals, 1000);
  const marketingConsent = data.marketingConsent === true;
  const consentText = s(data.consentText, 1000);

  if (!displayName) throw new HttpsError('invalid-argument', 'Please enter your name.');
  if (!phone) throw new HttpsError('invalid-argument', 'Please enter a phone number.');

  const FV = admin.firestore.FieldValue;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const u = userSnap.exists ? userSnap.data() : {};
  const email = (u.email || (request.auth.token && request.auth.token.email) || '').toString().toLowerCase();

  // 1) Update the member's profile doc + flip the onboarding gate.
  // Record the marketing/communications consent as a durable proof-of-opt-in:
  // the boolean, the timestamp, and the exact wording the member agreed to.
  const profilePatch = {
    displayName: displayName || u.displayName || null,
    phone, address, company, industry, location,
    communityGoals: goals,
    marketingConsent,
    onboardingComplete: true,
    onboardingAt: FV.serverTimestamp(),
    lastActiveAt: FV.serverTimestamp()
  };
  if (marketingConsent) {
    profilePatch.marketingConsentAt = FV.serverTimestamp();
    if (consentText) profilePatch.marketingConsentText = consentText;
  }
  await userRef.set(profilePatch, { merge: true });

  // 1b) First completion activates any referral that brought this member in.
  // Points land here rather than at signup so a referrer is paid for members
  // who actually show up, not for addresses that were typed into a form.
  // Never allowed to block onboarding.
  if (u.onboardingComplete !== true) {
    try {
      await creditReferralOnActivation(db, uid, u);
    } catch (e) {
      console.warn('[submitOnboarding] referral credit skipped:', e && e.message);
    }
  }

  // 2) Upsert into the CRM (best-effort).
  try {
    const companyId = await resolveAcademyCompanyId(db);
    if (companyId && EMAIL_RE.test(email)) {
      const ref = await upsertCrmContact(db, companyId, {
        name: displayName,
        email,
        phone,
        address,
        companyName: company,
        source: 'Member Signup',
        tags: [
          'Member',
          industry ? `Industry: ${industry}`.slice(0, 40) : null,
          marketingConsent ? 'Opt-In: Calls/SMS/Email' : null
        ].filter(Boolean)
      });
      // Persist consent flags on the contact for filtering/segmenting.
      await ref.set({
        marketingConsent,
        marketingConsentAt: marketingConsent ? FV.serverTimestamp() : null,
        marketingConsentText: marketingConsent ? (consentText || null) : null
      }, { merge: true });
      await ref.collection('activities').add({
        type: 'member_onboarding',
        description: 'Completed member-portal onboarding'
          + (goals ? ` — Goals: ${goals.slice(0, 200)}` : ''),
        actorUid: 'system',
        actorName: 'Member onboarding',
        createdAt: FV.serverTimestamp(),
        meta: { phone, address, company, industry, location, goals }
      });
      // Separate, explicit consent record (proof of opt-in / opt-out).
      await ref.collection('activities').add({
        type: 'consent_updated',
        description: marketingConsent
          ? 'Opted IN to calls, SMS, and email communications'
          : 'Did NOT opt in to calls, SMS, or email communications',
        actorUid: 'system',
        actorName: 'Consent capture',
        createdAt: FV.serverTimestamp(),
        meta: { marketingConsent, consentText: consentText || null, channel: 'onboarding' }
      });
    }
  } catch (e) {
    console.warn('[submitOnboarding] CRM upsert failed:', e && e.message);
  }

  return { ok: true };
});


// ────────────────────────────────────────────────────────────────
// sendgridEventWebhook — HTTP function (public)
// ────────────────────────────────────────────────────────────────

function verifySignature(publicKeyPem, payloadRaw, signature, timestamp) {
  if (!publicKeyPem || !signature || !timestamp) return false;
  try {
    const timestampedPayload = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      payloadRaw
    ]);
    const verifier = crypto.createVerify('sha256');
    verifier.update(timestampedPayload);
    verifier.end();
    const decodedSig = Buffer.from(signature, 'base64');
    return verifier.verify(publicKeyPem, decodedSig);
  } catch (e) {
    console.warn('[webhook] signature verify error:', e && e.message);
    return false;
  }
}

exports.sendgridEventWebhook = onRequest(
  { cors: false, invoker: 'public' },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(200).send('ok');
        return;
      }

      // Get raw body for signature verification. Firebase Functions v2 provides req.rawBody.
      const rawBody = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body || []));

      // Webhook signing is optional. Read from env if set; otherwise accept unsigned.
      const webhookKey = (process.env.SENDGRID_WEBHOOK_KEY || '').trim();

      if (webhookKey && webhookKey.trim()) {
        const signature = req.get('X-Twilio-Email-Event-Webhook-Signature');
        const timestamp = req.get('X-Twilio-Email-Event-Webhook-Timestamp');
        const ok = verifySignature(webhookKey, rawBody, signature, timestamp);
        if (!ok) {
          console.warn('[webhook] signature invalid — ignoring payload');
          res.status(200).send('ok');
          return;
        }
      } else {
        console.warn('[webhook] SENDGRID_WEBHOOK_KEY not set — accepting without signature verification');
      }

      const events = Array.isArray(req.body) ? req.body : [];
      const db = admin.firestore();

      // Counter per campaign, increments per type.
      const campaignIncrements = new Map();

      function bump(cid, field) {
        if (!cid) return;
        const m = campaignIncrements.get(cid) || {};
        m[field] = (m[field] || 0) + 1;
        campaignIncrements.set(cid, m);
      }

      for (const ev of events) {
        try {
          const type = ev.event || 'unknown';
          const companyId = ev.companyId;
          const campaignId = ev.campaignId;
          const contactId = ev.contactId;
          const email = ev.email || null;
          const timestamp = ev.timestamp ? new Date(ev.timestamp * 1000) : new Date();
          const eventId = ev.sg_event_id || (`${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

          if (companyId && campaignId) {
            // Write event to events subcollection.
            const evRef = db.collection('companies').doc(companyId)
              .collection('campaigns').doc(campaignId)
              .collection('events').doc(eventId);
            await evRef.set({
              type,
              email,
              timestamp,
              url: ev.url || null,
              reason: ev.reason || ev.response || null,
              raw: {
                sg_message_id: ev.sg_message_id || null,
                useragent: ev.useragent || null,
                ip: ev.ip || null
              }
            }, { merge: true });

            // Aggregate counters.
            if (type === 'delivered') bump(`${companyId}/${campaignId}`, 'stats.delivered');
            else if (type === 'open') bump(`${companyId}/${campaignId}`, 'stats.opens');
            else if (type === 'click') bump(`${companyId}/${campaignId}`, 'stats.clicks');
            else if (type === 'bounce' || type === 'dropped') bump(`${companyId}/${campaignId}`, 'stats.bounces');
            else if (type === 'unsubscribe' || type === 'group_unsubscribe' || type === 'spamreport') bump(`${companyId}/${campaignId}`, 'stats.unsubs');
          }

          // 1-on-1 contact email events → append activity.
          if (companyId && contactId && !campaignId) {
            try {
              const contactRef = db.collection('companies').doc(companyId)
                .collection('contacts').doc(contactId);
              await contactRef.collection('activities').add({
                type: 'email_event',
                description: `Email ${type}${email ? ' · ' + email : ''}`,
                actorUid: 'system',
                actorName: 'SendGrid',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                meta: {
                  eventType: type,
                  email,
                  url: ev.url || null,
                  reason: ev.reason || ev.response || null,
                  messageId: ev.sg_message_id || null
                }
              });
            } catch (e) {
              console.warn('[webhook] contact activity write failed:', e && e.message);
            }
          }
        } catch (perEvErr) {
          console.warn('[webhook] event error:', perEvErr && perEvErr.message);
        }
      }

      // Apply aggregate counter updates.
      for (const [key, fields] of campaignIncrements.entries()) {
        const [companyId, campaignId] = key.split('/');
        const campRef = db.collection('companies').doc(companyId).collection('campaigns').doc(campaignId);
        const updates = {};
        Object.keys(fields).forEach((f) => {
          updates[f] = admin.firestore.FieldValue.increment(fields[f]);
        });
        try {
          await campRef.set(updates, { merge: true });
        } catch (e) {
          console.warn('[webhook] campaign counter update failed:', e && e.message);
        }
      }

      res.status(200).send('ok');
    } catch (err) {
      console.error('[webhook] fatal:', err && err.message);
      res.status(200).send('ok'); // Always 200 to prevent SendGrid from retrying.
    }
  }
);

// ────────────────────────────────────────────────────────────────
// Phase 2 — Community leaderboard, points & levels.
//
// Three Firestore triggers (post create, comment create, like write) maintain
// a per-user stats subcollection at users/{uid}/stats/aggregate, plus mirror
// fields `statsPoints` / `statsWeekPoints` on the parent user doc so the
// leaderboard query can `orderBy('statsPoints')` without a collectionGroup.
//
// Points formula:
//   - post created      +5 points (+10 if category=='wins')
//   - comment created   +1 point
//   - like received     +2 points to the post author
//   - like given        0 points (vanity stat)
//
// Levels are computed client-side from `points` — never written to Firestore.
//
// Weekly reset is "lazy": each trigger compares the stat doc's
// `weekStartedAt` to the current Monday-00:00-UTC. If older, weekPoints
// resets to the current delta; otherwise it increments. No Pub/Sub needed.
// ────────────────────────────────────────────────────────────────

const POINTS = {
  POST: 5,
  POST_WIN: 10,
  COMMENT: 1,
  LIKE_RECEIVED: 2
};

function currentWeekStartUTC() {
  // Monday 00:00:00.000 UTC of the current week.
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (day + 6) % 7; // Mon=0, Tue=1, .., Sun=6
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - offsetToMonday,
    0, 0, 0, 0
  ));
  return monday;
}

/**
 * Apply a points delta to a user's stat aggregate doc + mirror fields on the
 * parent user doc, with lazy week-roll. Also bumps the named counter (e.g.
 * 'postCount', 'commentCount', 'likesReceived') by `counterDelta`.
 *
 * Single transaction for read-then-write atomicity. Cheap (1 read + 2 writes).
 */
async function applyPointsDelta(db, uid, pointsDelta, counters) {
  if (!uid) return;
  const userRef = db.collection('users').doc(uid);
  const statRef = userRef.collection('stats').doc('aggregate');
  const weekStart = currentWeekStartUTC();

  await db.runTransaction(async (tx) => {
    const [statSnap, userSnap] = await Promise.all([tx.get(statRef), tx.get(userRef)]);
    const stat = statSnap.exists ? statSnap.data() : {};
    const prevWeekStart = stat.weekStartedAt && stat.weekStartedAt.toMillis
      ? new Date(stat.weekStartedAt.toMillis())
      : null;
    const sameWeek = prevWeekStart && prevWeekStart.getTime() >= weekStart.getTime();

    const nextPoints = Math.max(0, (stat.points || 0) + pointsDelta);
    const nextWeekPoints = sameWeek
      ? Math.max(0, (stat.weekPoints || 0) + pointsDelta)
      : Math.max(0, pointsDelta);

    const statPatch = {
      points: nextPoints,
      weekPoints: nextWeekPoints,
      weekStartedAt: admin.firestore.Timestamp.fromDate(weekStart),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (counters) {
      Object.keys(counters).forEach((k) => {
        statPatch[k] = Math.max(0, (stat[k] || 0) + counters[k]);
      });
    }
    tx.set(statRef, statPatch, { merge: true });

    // Mirror onto user doc so the leaderboard query can orderBy without a
    // collectionGroup on the subcollection. Only write if the user doc exists
    // (otherwise we'd create a doc lacking auth-bound fields like email).
    if (userSnap.exists) {
      tx.set(userRef, {
        statsPoints: nextPoints,
        statsWeekPoints: nextWeekPoints
      }, { merge: true });
    }
  });
}

// Trigger handlers (onPostCreated / onCommentCreated / onLikeWritten) are
// defined further down in the Phase 3 block; they handle BOTH the points
// updates and the notification fan-out so the trigger boundary stays simple.

/**
 * getLeaderboard({ scope='global'|'company', limit=20 }) — callable.
 *
 * Returns the top N users by all-time `statsPoints`. Server-side because the
 * `users` collection has `allow list: if isOwner()` — going through Admin SDK
 * lets us project ONLY the safe fields (uid, displayName, avatarUrl,
 * statsPoints, statsWeekPoints, level) without leaking emails / companyIds.
 *
 * scope='company' restricts to caller's companyId. Owner sees global.
 */
exports.getLeaderboard = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const scope = data.scope === 'company' ? 'company' : 'global';
  const lim = Math.max(1, Math.min(50, Number(data.limit) || 20));

  const db = admin.firestore();

  // Resolve caller context for company scoping.
  let callerCompanyId = null;
  try {
    const meSnap = await db.collection('users').doc(callerUid).get();
    if (meSnap.exists) callerCompanyId = meSnap.data().companyId || null;
  } catch (e) { /* best-effort */ }

  let q;
  if (scope === 'company' && callerCompanyId) {
    q = db.collection('users')
      .where('companyId', '==', callerCompanyId)
      .orderBy('statsPoints', 'desc')
      .limit(lim);
  } else {
    q = db.collection('users')
      .orderBy('statsPoints', 'desc')
      .limit(lim);
  }

  let snap;
  try {
    snap = await q.get();
  } catch (err) {
    console.error('[getLeaderboard] query failed:', err && err.message);
    throw new HttpsError('internal', 'Could not load leaderboard.');
  }

  const rows = snap.docs.map((d) => {
    const u = d.data() || {};
    return {
      uid: d.id,
      displayName: u.displayName || u.email || 'Unknown',
      avatarUrl: u.avatarUrl || null,
      statsPoints: Number(u.statsPoints || 0),
      statsWeekPoints: Number(u.statsWeekPoints || 0)
    };
  }).filter((r) => r.statsPoints > 0); // Hide users who never engaged.

  return { ok: true, scope, rows };
});

/**
 * recomputeUserStats({ uid }) — owner-only callable. Repair / backfill path.
 *
 * Paginates the target user's posts + likes-received and rewrites the stat
 * aggregate from scratch. Comments aren't easily countable across all parent
 * posts without a collectionGroup query, so commentCount is reset to 0 — the
 * trigger will re-accumulate going forward. Acceptable for v1.
 */
exports.recomputeUserStats = onCall(async (request) => {
  const isOwnerClaim = request.auth && request.auth.token && request.auth.token.role === 'owner';
  if (!isOwnerClaim) throw new HttpsError('permission-denied', 'Owner only.');

  const uid = (request.data && request.data.uid || '').toString().trim();
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const statRef = userRef.collection('stats').doc('aggregate');

  // Posts authored by this user — drives postCount + base post points.
  let postCount = 0;
  let winsCount = 0;
  let likesReceived = 0;
  const authoredPostIds = [];
  try {
    const postsSnap = await db.collection('posts').where('authorUid', '==', uid).get();
    postsSnap.forEach((d) => {
      const p = d.data() || {};
      postCount += 1;
      if (p.category === 'wins') winsCount += 1;
      likesReceived += Number(p.likeCount || 0);
      authoredPostIds.push(d.id);
    });
  } catch (err) {
    console.error('[recomputeUserStats] posts query failed:', err && err.message);
    throw new HttpsError('internal', 'Could not read posts.');
  }

  const points =
    (postCount - winsCount) * POINTS.POST +
    winsCount * POINTS.POST_WIN +
    likesReceived * POINTS.LIKE_RECEIVED;

  const weekStart = currentWeekStartUTC();

  await db.runTransaction(async (tx) => {
    tx.set(statRef, {
      points,
      postCount,
      commentCount: 0,
      likesReceived,
      likesGiven: 0,
      weekPoints: 0,
      weekStartedAt: admin.firestore.Timestamp.fromDate(weekStart),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(userRef, {
      statsPoints: points,
      statsWeekPoints: 0
    }, { merge: true });
  });

  return { ok: true, uid, points, postCount, winsCount, likesReceived };
});

// ────────────────────────────────────────────────────────────────
// Phase 3 — Notifications (mention / like / comment) + FCM push
// + member search.
//
// Triggers fan out one Firestore notification doc per recipient. Doc IDs
// are deterministic so re-firing (e.g. unlike → like) collapses into a
// single row instead of spamming the inbox. unreadNotifCount on the user
// doc mirrors the count of unread notifs, used to badge the bell icon
// without an extra query.
// ────────────────────────────────────────────────────────────────

const NOTIF_TRUNCATE = 140;

function clampPreview(text) {
  if (!text) return '';
  const t = String(text).trim();
  return t.length > NOTIF_TRUNCATE ? t.slice(0, NOTIF_TRUNCATE) + '…' : t;
}

/**
 * Send a multicast FCM push to a user's registered tokens. Best-effort:
 * never throws. Prunes tokens that come back as not-registered.
 */
async function pushToUser(db, uid, payload) {
  if (!uid || !payload) return { sent: 0, failed: 0 };
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return { sent: 0, failed: 0 };
    const data = userSnap.data() || {};
    const prefs = data.notifPrefs || {};
    if (prefs.push === false) return { sent: 0, failed: 0 };
    const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter((t) => typeof t === 'string' && t) : [];
    if (!tokens.length) return { sent: 0, failed: 0 };

    const messaging = admin.messaging();
    const message = {
      tokens,
      notification: {
        title: payload.title || 'Kailey Brown',
        body: payload.body || ''
      },
      data: payload.data || {},
      webpush: {
        fcmOptions: { link: (payload.data && payload.data.url) || `${APP_BASE_URL}/community.html` }
      }
    };
    const resp = await messaging.sendEachForMulticast(message);
    const stale = [];
    (resp.responses || []).forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) stale.push(tokens[i]);
    });
    if (stale.length) {
      try {
        await db.collection('users').doc(uid).set({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...stale)
        }, { merge: true });
      } catch (e) { /* ignore */ }
    }
    return { sent: resp.successCount || 0, failed: resp.failureCount || 0 };
  } catch (err) {
    console.error('[pushToUser] failed:', err && err.message);
    return { sent: 0, failed: 0 };
  }
}

/**
 * Write a notification with a deterministic ID. If it already exists
 * AND was unread, this is a no-op (avoids double-counting on re-fire).
 * If it was read or didn't exist, sets to unread and bumps the parent
 * user doc's unreadNotifCount. Returns true iff this was a new unread.
 *
 * Uses a transaction so the count + doc stay consistent.
 */
async function notifyUser(db, recipientUid, notif, { typePrefKey } = {}) {
  if (!recipientUid || !notif || !notif.id) return false;
  const userRef = db.collection('users').doc(recipientUid);
  const notifRef = userRef.collection('notifications').doc(notif.id);

  const result = await db.runTransaction(async (tx) => {
    const [notifSnap, userSnap] = await Promise.all([tx.get(notifRef), tx.get(userRef)]);

    // Respect per-user opt-out (notifPrefs.mentions / .likes / .comments).
    if (typePrefKey && userSnap.exists) {
      const prefs = (userSnap.data() && userSnap.data().notifPrefs) || {};
      if (prefs[typePrefKey] === false) return { newUnread: false, skipped: true };
    }

    const wasUnread = notifSnap.exists && notifSnap.data().read === false;
    const willBeUnread = true;

    const patch = {
      type: notif.type,
      fromUid: notif.fromUid || null,
      fromName: notif.fromName || '',
      fromAvatar: notif.fromAvatar || null,
      postId: notif.postId || null,
      commentId: notif.commentId || null,
      // `category` is the channel key across the whole app — post notifications
      // use it to deep-link, and channel-access notifications reuse it so the
      // bell can offer Approve/Deny against the right channel.
      category: notif.category || null,
      channelName: notif.channelName || null,
      answerCount: typeof notif.answerCount === 'number' ? notif.answerCount : null,
      preview: notif.preview || '',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    tx.set(notifRef, patch, { merge: true });

    if (!wasUnread && willBeUnread && userSnap.exists) {
      tx.set(userRef, {
        unreadNotifCount: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
      return { newUnread: true, skipped: false };
    }
    return { newUnread: false, skipped: false };
  });

  return result.newUnread;
}

/**
 * Fan out @mention notifications to a set of recipients. Filters out the
 * actor (no self-notify) and dedupes. Caller passes the surrounding post
 * info so we don't re-read it. Optionally pushes FCM after the Firestore
 * write so badge counts are accurate even if push fails.
 */
async function fanOutMentions(db, mentionedUids, ctx) {
  if (!Array.isArray(mentionedUids) || !mentionedUids.length) return;
  const seen = new Set();
  for (const uid of mentionedUids) {
    if (!uid || uid === ctx.fromUid || seen.has(uid)) continue;
    seen.add(uid);
    const notifId = ctx.commentId
      ? `mention_comment_${ctx.commentId}_${ctx.fromUid}`
      : `mention_post_${ctx.postId}_${ctx.fromUid}`;
    const wasNew = await notifyUser(db, uid, {
      id: notifId,
      type: 'mention',
      fromUid: ctx.fromUid,
      fromName: ctx.fromName,
      fromAvatar: ctx.fromAvatar,
      postId: ctx.postId,
      commentId: ctx.commentId || null,
      category: ctx.category || null,
      preview: clampPreview(ctx.preview)
    }, { typePrefKey: 'mentions' });
    if (wasNew) {
      pushToUser(db, uid, {
        title: `${ctx.fromName || 'Someone'} mentioned you`,
        body: clampPreview(ctx.preview),
        data: {
          url: `${APP_BASE_URL}/community.html?post=${encodeURIComponent(ctx.postId)}`,
          type: 'mention',
          postId: ctx.postId
        }
      }).catch(() => {});
    }
  }
}

// Replace the Phase 2 onPostCreated to also fan out mention notifs, and
// piggyback the activity timestamp on the user doc.
//
// Each of the three community triggers is registered TWICE: once on the flat
// `posts` collection (public channels) and once on `channels/{channelKey}/posts`
// (private channels). Firestore triggers match a literal path, so without the
// second registration a private-channel post would silently earn no points and
// send no notifications. `channelKey` is null for the public path and is used to
// resolve the parent post document.
function postRefFor(db, channelKey, postId) {
  return channelKey
    ? db.collection('channels').doc(channelKey).collection('posts').doc(postId)
    : db.collection('posts').doc(postId);
}

async function handlePostCreated(event, channelKey) {
    const snap = event.data;
    if (!snap) return;
    const post = snap.data() || {};
    const author = post.authorUid;
    if (!author) return;

    const isWin = post.category === 'wins';
    const delta = isWin ? POINTS.POST_WIN : POINTS.POST;
    const db = admin.firestore();
    try {
      await applyPointsDelta(db, author, delta, { postCount: 1 });
    } catch (err) {
      console.error('[onPostCreated] points apply failed:', err && err.message);
    }

    // Mention fan-out.
    try {
      await fanOutMentions(db, post.mentionedUids || [], {
        fromUid: author,
        fromName: post.authorName || '',
        fromAvatar: post.authorAvatar || null,
        postId: snap.id,
        commentId: null,
        category: post.category || null,
        preview: post.text || ''
      });
    } catch (err) {
      console.error('[onPostCreated] mention fan-out failed:', err && err.message);
    }
}

exports.onPostCreated = onDocumentCreated(
  { document: 'posts/{postId}' },
  (event) => handlePostCreated(event, null)
);
exports.onPrivatePostCreated = onDocumentCreated(
  { document: 'channels/{channelKey}/posts/{postId}' },
  (event) => handlePostCreated(event, event.params.channelKey)
);

// Replace the Phase 2 onCommentCreated to also fan out comment + mention notifs.
async function handleCommentCreated(event, channelKey) {
    const snap = event.data;
    if (!snap) return;
    const comment = snap.data() || {};
    const commenter = comment.authorUid;
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    if (!commenter || !postId) return;

    const db = admin.firestore();
    try {
      await applyPointsDelta(db, commenter, POINTS.COMMENT, { commentCount: 1 });
    } catch (err) {
      console.error('[onCommentCreated] points apply failed:', err && err.message);
    }

    // Notify the post author (skip if commenter == author).
    let postData = null;
    try {
      const postSnap = await postRefFor(db, channelKey, postId).get();
      if (postSnap.exists) postData = postSnap.data();
    } catch (e) { /* tolerated */ }

    if (postData && postData.authorUid && postData.authorUid !== commenter) {
      try {
        const wasNew = await notifyUser(db, postData.authorUid, {
          id: `comment_${commentId}`,
          type: 'comment',
          fromUid: commenter,
          fromName: comment.authorName || '',
          fromAvatar: comment.authorAvatar || null,
          postId,
          commentId,
          category: postData.category || null,
          preview: clampPreview(comment.text || '')
        }, { typePrefKey: 'comments' });
        if (wasNew) {
          pushToUser(db, postData.authorUid, {
            title: `${comment.authorName || 'Someone'} commented on your post`,
            body: clampPreview(comment.text || ''),
            data: {
              url: `${APP_BASE_URL}/community.html?post=${encodeURIComponent(postId)}`,
              type: 'comment',
              postId
            }
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[onCommentCreated] author notify failed:', err && err.message);
      }
    }

    // Mention fan-out for @mentions in the comment body.
    try {
      await fanOutMentions(db, comment.mentionedUids || [], {
        fromUid: commenter,
        fromName: comment.authorName || '',
        fromAvatar: comment.authorAvatar || null,
        postId,
        commentId,
        category: postData ? (postData.category || null) : null,
        preview: comment.text || ''
      });
    } catch (err) {
      console.error('[onCommentCreated] mention fan-out failed:', err && err.message);
    }
}

exports.onCommentCreated = onDocumentCreated(
  { document: 'posts/{postId}/comments/{commentId}' },
  (event) => handleCommentCreated(event, null)
);
exports.onPrivateCommentCreated = onDocumentCreated(
  { document: 'channels/{channelKey}/posts/{postId}/comments/{commentId}' },
  (event) => handleCommentCreated(event, event.params.channelKey)
);

// Replace the Phase 2 onLikeWritten to also write a like notif on like-add.
// (Like-remove leaves the existing notif in place — typical social UX.)
async function handleLikeWritten(event, channelKey) {
    const beforeExists = event.data && event.data.before && event.data.before.exists;
    const afterExists = event.data && event.data.after && event.data.after.exists;
    if (beforeExists === afterExists) return;

    const liker = event.params.uid;
    const postId = event.params.postId;
    if (!liker || !postId) return;

    const isLikeAdded = !beforeExists && afterExists;
    const sign = isLikeAdded ? 1 : -1;

    const db = admin.firestore();
    let post = null;
    try {
      const postSnap = await postRefFor(db, channelKey, postId).get();
      if (postSnap.exists) post = { id: postSnap.id, ...postSnap.data() };
    } catch (err) {
      console.warn('[onLikeWritten] post fetch failed:', err && err.message);
    }

    try {
      await applyPointsDelta(db, liker, 0, { likesGiven: sign });
    } catch (err) {
      console.error('[onLikeWritten] liker stat update failed:', err && err.message);
    }

    if (post && post.authorUid && post.authorUid !== liker) {
      try {
        await applyPointsDelta(
          db,
          post.authorUid,
          sign * POINTS.LIKE_RECEIVED,
          { likesReceived: sign }
        );
      } catch (err) {
        console.error('[onLikeWritten] author stat update failed:', err && err.message);
      }

      // Only write a notif on like-add. We need the liker's display info; pull
      // it from the like-doc's parent author lookup if present, else fall back
      // to a fetch on the liker's user doc.
      if (isLikeAdded) {
        let likerName = '';
        let likerAvatar = null;
        try {
          const likerSnap = await db.collection('users').doc(liker).get();
          if (likerSnap.exists) {
            const u = likerSnap.data() || {};
            likerName = u.displayName || u.email || '';
            likerAvatar = u.avatarUrl || null;
          }
        } catch (e) { /* tolerated */ }

        try {
          const wasNew = await notifyUser(db, post.authorUid, {
            id: `like_${postId}_${liker}`,
            type: 'like',
            fromUid: liker,
            fromName: likerName,
            fromAvatar: likerAvatar,
            postId,
            commentId: null,
            category: post.category || null,
            preview: clampPreview(post.text || '')
          }, { typePrefKey: 'likes' });
          if (wasNew) {
            pushToUser(db, post.authorUid, {
              title: `${likerName || 'Someone'} liked your post`,
              body: clampPreview(post.text || ''),
              data: {
                url: `${APP_BASE_URL}/community.html?post=${encodeURIComponent(postId)}`,
                type: 'like',
                postId
              }
            }).catch(() => {});
          }
        } catch (err) {
          console.error('[onLikeWritten] author notify failed:', err && err.message);
        }
      }
    }
}

exports.onLikeWritten = onDocumentWritten(
  { document: 'posts/{postId}/likes/{uid}' },
  (event) => handleLikeWritten(event, null)
);
exports.onPrivateLikeWritten = onDocumentWritten(
  { document: 'channels/{channelKey}/posts/{postId}/likes/{uid}' },
  (event) => handleLikeWritten(event, event.params.channelKey)
);

/**
 * searchMembers({ query }) — autocomplete for @mention picking.
 *
 * Server-side because the `users` collection has `allow list: if isOwner()`.
 * We project safe fields only (uid, displayName, avatarUrl) and scope the
 * candidate set to the caller's visibility:
 *   - owner → all users
 *   - team user / admin → company members + owner
 *   - individual buyer → owner only (closest thing to a "global" they share with)
 *
 * Returns up to 10 matches sorted by displayName asc.
 */
exports.searchMembers = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const q = (data.query || '').toString().trim().toLowerCase();
  if (!q) return { ok: true, results: [] };

  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
  const db = admin.firestore();

  let callerCompanyId = null;
  if (!isOwnerClaim) {
    try {
      const meSnap = await db.collection('users').doc(callerUid).get();
      if (meSnap.exists) callerCompanyId = meSnap.data().companyId || null;
    } catch (e) { /* best-effort */ }
  }

  // Collect a candidate pool, then filter by prefix match in JS. Prefix-only
  // matching ('alex' matches 'Alex Chen', 'alexandra'; not 'sandra alex').
  const pool = new Map(); // uid → { uid, displayName, avatarUrl }
  function add(uid, doc) {
    if (!uid || pool.has(uid)) return;
    const u = doc || {};
    pool.set(uid, {
      uid,
      displayName: u.displayName || u.email || 'Unknown',
      avatarUrl: u.avatarUrl || null
    });
  }

  try {
    if (isOwnerClaim) {
      const snap = await db.collection('users').limit(500).get();
      snap.docs.forEach((d) => add(d.id, d.data()));
    } else if (callerCompanyId) {
      const memSnap = await db.collection('companies').doc(callerCompanyId).collection('members').limit(500).get();
      memSnap.docs.forEach((d) => add(d.id, d.data()));
      // Also include owner so users can @mention support.
      const ownerSnap = await db.collection('users').where('email', '==', OWNER_EMAIL).limit(1).get();
      ownerSnap.docs.forEach((d) => add(d.id, d.data()));
    } else {
      // Individual buyer — only owner is visible to them via @mention.
      const ownerSnap = await db.collection('users').where('email', '==', OWNER_EMAIL).limit(1).get();
      ownerSnap.docs.forEach((d) => add(d.id, d.data()));
    }
  } catch (err) {
    console.error('[searchMembers] candidate pool fetch failed:', err && err.message);
    return { ok: false, results: [] };
  }

  const results = Array.from(pool.values())
    .filter((u) => (u.displayName || '').toLowerCase().includes(q))
    .sort((a, b) => {
      // Prefix matches first, then alphabetical.
      const ap = (a.displayName || '').toLowerCase().startsWith(q) ? 0 : 1;
      const bp = (b.displayName || '').toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.displayName || '').localeCompare(b.displayName || '');
    })
    .slice(0, 10);

  return { ok: true, results };
});

// ────────────────────────────────────────────────────────────────
// Community invite tokens.
//
// Owner / admin generates a shareable invite link; recipient signs up
// via /signup.html?invite=<token>; the signup flow calls
// acceptCommunityInvite to record the use. Server-only collection so
// tokens never leak via client list operations.
// ────────────────────────────────────────────────────────────────

const COMMUNITY_INVITE_DEFAULT_USES = 100;
const COMMUNITY_INVITE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function makeInviteToken() {
  // 12 URL-safe characters via base64url of 9 random bytes.
  return crypto.randomBytes(9).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * createCommunityInvite({ usesAllowed?, ttlMs? }) — owner / admin only.
 * Returns { token, url, expiresAt }.
 */
exports.createCommunityInvite = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';

  const db = admin.firestore();

  // Owner is always allowed; otherwise the caller must be a company admin.
  if (!isOwnerClaim) {
    let isAnyCompanyAdmin = false;
    try {
      const meSnap = await db.collection('users').doc(callerUid).get();
      const cid = meSnap.exists ? (meSnap.data().companyId || null) : null;
      if (cid) {
        const compSnap = await db.collection('companies').doc(cid).get();
        const adminUids = compSnap.exists ? (compSnap.data().adminUids || []) : [];
        isAnyCompanyAdmin = adminUids.includes(callerUid);
      }
    } catch (e) { /* best-effort */ }
    if (!isAnyCompanyAdmin) {
      throw new HttpsError('permission-denied', 'Only owners and admins can create invites.');
    }
  }

  // Throttle invite creation: 30 per caller per hour.
  await rateLimitCaller(db, request, { action: 'createCommunityInvite', max: 30, windowSec: 3600 });

  const data = request.data || {};
  const usesAllowed = Math.max(1, Math.min(1000, Number(data.usesAllowed) || COMMUNITY_INVITE_DEFAULT_USES));
  const ttlMs = Math.max(60 * 60 * 1000, Math.min(365 * 24 * 60 * 60 * 1000, Number(data.ttlMs) || COMMUNITY_INVITE_DEFAULT_TTL_MS));
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + ttlMs);

  // Look up creator's display name for analytics.
  let createdByName = (request.auth.token && request.auth.token.name) || null;
  if (!createdByName) {
    try {
      const meSnap = await db.collection('users').doc(callerUid).get();
      if (meSnap.exists) createdByName = meSnap.data().displayName || meSnap.data().email || null;
    } catch (e) { /* tolerated */ }
  }

  // Generate a token and ensure no collision (extremely unlikely; one retry).
  let token = makeInviteToken();
  for (let i = 0; i < 3; i++) {
    const probe = await db.collection('communityInvites').doc(token).get();
    if (!probe.exists) break;
    token = makeInviteToken();
  }

  await db.collection('communityInvites').doc(token).set({
    token,
    kind: 'admin',
    createdByUid: callerUid,
    createdByName: createdByName || 'Unknown',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
    usesAllowed,
    usesUsed: 0,
    usedBy: []
  });

  const url = `${APP_BASE_URL}/signup.html?invite=${encodeURIComponent(token)}`;
  return { ok: true, token, url, expiresAt: expiresAt.toMillis(), usesAllowed };
});

/**
 * acceptCommunityInvite({ token }) — any authenticated user.
 *
 * Validates the token (exists, not expired, has uses remaining) and
 * records this user's acceptance. Idempotent: a user accepting twice is
 * a no-op (their uid is added to usedBy at most once). Returns
 * { ok, alreadyAccepted? } so the client can decide whether to celebrate.
 */
exports.acceptCommunityInvite = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const token = (request.data && request.data.token || '').toString().trim();
  if (!token) throw new HttpsError('invalid-argument', 'Token is required.');

  const db = admin.firestore();
  const ref = db.collection('communityInvites').doc(token);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Invite not found.');
    }
    const inv = snap.data() || {};

    const now = Date.now();
    const exp = inv.expiresAt && inv.expiresAt.toMillis ? inv.expiresAt.toMillis() : 0;
    if (exp && exp < now) {
      throw new HttpsError('failed-precondition', 'Invite has expired.');
    }
    const used = Number(inv.usesUsed || 0);
    const allowed = Number(inv.usesAllowed || COMMUNITY_INVITE_DEFAULT_USES);
    if (used >= allowed) {
      throw new HttpsError('resource-exhausted', 'Invite has no uses remaining.');
    }
    // A member's own link must not credit themselves.
    if (inv.createdByUid && inv.createdByUid === uid) {
      throw new HttpsError('failed-precondition', 'You can\'t join with your own invite link.');
    }
    const usedBy = Array.isArray(inv.usedBy) ? inv.usedBy : [];
    if (usedBy.includes(uid)) {
      return { alreadyAccepted: true, inviterUid: inv.createdByUid || null };
    }
    tx.update(ref, {
      usesUsed: used + 1,
      usedBy: admin.firestore.FieldValue.arrayUnion(uid),
      lastAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { alreadyAccepted: false, inviterUid: inv.createdByUid || null };
  });

  // Stamp the accepting user's doc with referral info. `invitedByUid` is
  // denormalized so the activation credit in submitOnboarding doesn't need a
  // second lookup. Best-effort — the token alone is enough to recover from.
  try {
    await db.collection('users').doc(uid).set({
      invitedByToken: token,
      invitedByUid: result.inviterUid || null,
      invitedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) { /* tolerated */ }

  // inviterUid stays server-side — the accepting user has no business knowing
  // which account owns the link they followed.
  const { inviterUid, ...clientResult } = result;
  return { ok: true, ...clientResult };
});

// ────────────────────────────────────────────────────────────────
// Member referral codes.
//
// Every member gets ONE stable invite token, minted on first request and
// recorded at users/{uid}.referralToken so the same link comes back forever —
// a fresh token per click would scatter one member's referrals across several
// codes and break their score. The token is an ordinary communityInvites doc
// tagged kind:'member', so /signup.html?invite=<token> and
// acceptCommunityInvite work on it unchanged.
//
// Scoring is deliberately split from joining: the inviter earns
// REFERRAL_POINTS when a referred member *activates* (finishes onboarding),
// not when the account is created. Crediting at signup would pay out for
// throwaway addresses, which is exactly how referral leaderboards get gamed.
// ────────────────────────────────────────────────────────────────

const MEMBER_INVITE_USES = 500;
const MEMBER_INVITE_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000; // effectively no expiry

/**
 * getMyReferralCode() — any authenticated member.
 * Returns { token, url, joined, activated, pointsEarned, pointsPerReferral },
 * minting the caller's stable token on first call.
 */
exports.getMyReferralCode = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const invites = db.collection('communityInvites');

  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError('failed-precondition', 'Finish creating your account first.');
  }
  const u = userSnap.data() || {};

  let token = (u.referralToken || '').toString().trim() || null;
  let inviteSnap = token ? await invites.doc(token).get() : null;

  if (!inviteSnap || !inviteSnap.exists) {
    // Minting is the only expensive path, so it's the only one throttled —
    // repeat panel loads on an existing code stay free.
    await rateLimitCaller(db, request, { action: 'getMyReferralCode', max: 10, windowSec: 3600 });

    let candidate = makeInviteToken();
    for (let i = 0; i < 3; i++) {
      const probe = await invites.doc(candidate).get();
      if (!probe.exists) break;
      candidate = makeInviteToken();
    }

    // Claim the token on the user doc transactionally so two concurrent calls
    // can't hand the same member two different codes.
    token = await db.runTransaction(async (tx) => {
      const s = await tx.get(userRef);
      const existing = s.exists ? ((s.data().referralToken || '').toString().trim() || null) : null;
      if (existing) return existing;
      tx.set(userRef, { referralToken: candidate }, { merge: true });
      return candidate;
    });

    inviteSnap = await invites.doc(token).get();
    if (!inviteSnap.exists) {
      await invites.doc(token).set({
        token,
        kind: 'member',
        createdByUid: uid,
        createdByName: u.displayName || u.email || 'Member',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + MEMBER_INVITE_TTL_MS),
        usesAllowed: MEMBER_INVITE_USES,
        usesUsed: 0,
        usedBy: [],
        activatedCount: 0,
        activatedBy: []
      });
      inviteSnap = await invites.doc(token).get();
    }
  }

  const inv = inviteSnap.data() || {};
  const activated = Number(inv.activatedCount || 0);
  return {
    ok: true,
    token,
    url: `${APP_BASE_URL}/signup.html?invite=${encodeURIComponent(token)}`,
    joined: Number(inv.usesUsed || 0),
    activated,
    pointsEarned: activated * REFERRAL_POINTS,
    pointsPerReferral: REFERRAL_POINTS
  };
});

/**
 * Credit the referrer once a member they invited finishes onboarding.
 *
 * Idempotent twice over — guarded by users/{uid}.referralCredited and by the
 * invite doc's activatedBy array — so replaying it awards nothing. Returns the
 * credited uid, or null when there was nothing to credit.
 */
async function creditReferralOnActivation(db, uid, userData) {
  const u = userData || {};
  if (u.referralCredited === true) return null;
  const token = (u.invitedByToken || '').toString().trim();
  if (!token) return null;

  const inviteRef = db.collection('communityInvites').doc(token);
  const userRef = db.collection('users').doc(uid);
  const FV = admin.firestore.FieldValue;

  const inviterUid = await db.runTransaction(async (tx) => {
    const [invSnap, meSnap] = await Promise.all([tx.get(inviteRef), tx.get(userRef)]);
    if (!invSnap.exists) return null;
    if (meSnap.exists && meSnap.data().referralCredited === true) return null;

    const inv = invSnap.data() || {};
    const owner = inv.createdByUid || null;
    if (!owner || owner === uid) return null; // no self-referral
    const already = Array.isArray(inv.activatedBy) ? inv.activatedBy : [];
    if (already.includes(uid)) return null;

    tx.set(inviteRef, {
      activatedCount: FV.increment(1),
      activatedBy: FV.arrayUnion(uid),
      lastActivatedAt: FV.serverTimestamp()
    }, { merge: true });
    tx.set(userRef, {
      referralCredited: true,
      referralCreditedAt: FV.serverTimestamp()
    }, { merge: true });
    return owner;
  });

  if (!inviterUid) return null;
  await applyPointsDelta(db, inviterUid, REFERRAL_POINTS, { referralCount: 1 });
  return inviterUid;
}

// ════════════════════════════════════════════════════════════════
// Private channels — membership and access requests.
//
// A channel has two independent flags:
//   listed     — appears in everyone's sidebar
//   visibility — 'private' means only memberUids (plus staff) read its posts
//
// Private-channel posts live at channels/{key}/posts/** so the rules can gate a
// whole query on the path. Membership itself is written ONLY from here: the
// channels/{key} doc is owner-only writable in rules, and the Admin SDK bypasses
// that, which is what allows admins — not just the owner — to approve requests.
// ════════════════════════════════════════════════════════════════

/** Every owner/admin uid, for fan-out of request notifications. */
async function staffUids(db) {
  const out = new Set();
  try {
    const snap = await db.collection('users').where('role', 'in', ['owner', 'admin']).get();
    snap.forEach((d) => out.add(d.id));
  } catch (e) {
    console.warn('[channels] staffUids lookup failed', e && e.message);
  }
  return Array.from(out);
}

/**
 * backfillChannelDefaults() — owner only, safe to re-run.
 *
 * Writes `visibility: 'public'` and `listed: true` onto every channel doc that
 * is missing them. This MUST run before the tightened channels/{key} list rule
 * is relied upon: that rule matches `listed == true`, and Firestore's equality
 * operators skip documents where the field is ABSENT — so without the backfill
 * every pre-existing channel would drop out of the sidebar for non-staff.
 */
exports.backfillChannelDefaults = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
  if (!isOwnerClaim) throw new HttpsError('permission-denied', 'Owner only.');

  const db = admin.firestore();
  const snap = await db.collection('channels').get();
  const batch = db.batch();
  let patched = 0;
  const touched = [];

  snap.forEach((d) => {
    const c = d.data() || {};
    const patch = {};
    if (typeof c.visibility !== 'string') patch.visibility = 'public';
    if (typeof c.listed !== 'boolean') patch.listed = true;
    if (!Array.isArray(c.memberUids)) patch.memberUids = [];
    if (Object.keys(patch).length) {
      batch.set(d.ref, patch, { merge: true });
      patched += 1;
      touched.push(d.id);
    }
  });

  if (patched) await batch.commit();
  return { ok: true, total: snap.size, patched, channels: touched };
});

/**
 * requestChannelAccess({ channelKey }) — any authenticated member.
 *
 * Records a pending request and notifies staff. No-ops when the caller is
 * already a member or already has a pending request, so a double tap is free.
 */
exports.requestChannelAccess = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const channelKey = String((request.data && request.data.channelKey) || '').trim();
  if (!channelKey) throw new HttpsError('invalid-argument', 'channelKey is required.');

  const db = admin.firestore();
  await rateLimitCaller(db, request, { action: 'requestChannelAccess', max: 10, windowSec: 3600 });

  const chanRef = db.collection('channels').doc(channelKey);
  const chanSnap = await chanRef.get();
  if (!chanSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
  const chan = chanSnap.data() || {};
  if (chan.visibility !== 'private') {
    throw new HttpsError('failed-precondition', 'That channel is already open to everyone.');
  }
  const members = Array.isArray(chan.memberUids) ? chan.memberUids : [];
  if (members.includes(uid)) return { ok: true, alreadyMember: true };

  const reqRef = chanRef.collection('requests').doc(uid);
  const existing = await reqRef.get();
  if (existing.exists && (existing.data() || {}).status === 'pending') {
    return { ok: true, alreadyPending: true };
  }

  let displayName = (request.auth.token && request.auth.token.name) || null;
  let avatarUrl = null;
  try {
    const meSnap = await db.collection('users').doc(uid).get();
    if (meSnap.exists) {
      const me = meSnap.data() || {};
      displayName = me.displayName || displayName || me.email || 'Member';
      avatarUrl = me.avatarUrl || null;
    }
  } catch (e) { /* tolerated — the request matters more than the label */ }

  // Application answers, when the channel asks for them. The client owns the
  // question list (see CHANNEL_ACCESS_FORMS in public/js/community.js) and sends
  // the question text alongside each answer, so a later rewording doesn't
  // relabel what someone already submitted. This end only enforces bounds —
  // count and length — so a crafted payload can't bloat the doc. The content is
  // shown to staff and escaped on render; it grants nothing.
  const rawAnswers = Array.isArray(request.data && request.data.answers)
    ? request.data.answers
    : [];
  const answers = rawAnswers
    .slice(0, 12)
    .map((a) => ({
      question: String((a && a.question) || '').trim().slice(0, 200),
      answer: String((a && a.answer) || '').trim().slice(0, 2000)
    }))
    .filter((a) => a.question && a.answer);

  await reqRef.set({
    uid,
    displayName: displayName || 'Member',
    avatarUrl,
    status: 'pending',
    channelKey,
    answers,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Fan out to staff through the same inbox the topbar bell already renders.
  const recipients = await staffUids(db);
  await Promise.all(recipients.filter((r) => r !== uid).map((r) => notifyUser(db, r, {
    id: `chanreq_${channelKey}_${uid}`,
    type: 'channel_request',
    fromUid: uid,
    fromName: displayName || 'Member',
    fromAvatar: avatarUrl,
    category: channelKey,
    channelName: chan.name || channelKey,
    answerCount: answers.length,
    preview: answers.length
      ? `wants access to ${chan.name || channelKey} — ${answers.length} answer${answers.length === 1 ? '' : 's'} to review`
      : `wants access to ${chan.name || channelKey}`
  }).catch(() => null)));

  return { ok: true, pending: true };
});

/**
 * decideChannelAccess({ channelKey, uid, approve }) — owner/admin only.
 * Approving adds the uid to memberUids; either way the requester is notified.
 */
exports.decideChannelAccess = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const channelKey = String((request.data && request.data.channelKey) || '').trim();
  const targetUid = String((request.data && request.data.uid) || '').trim();
  const approve = request.data && request.data.approve === true;
  if (!channelKey || !targetUid) {
    throw new HttpsError('invalid-argument', 'channelKey and uid are required.');
  }

  const chanRef = db.collection('channels').doc(channelKey);
  const chanSnap = await chanRef.get();
  if (!chanSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
  const chan = chanSnap.data() || {};
  const deciderUid = request.auth.uid;
  const FV = admin.firestore.FieldValue;

  if (approve) {
    await chanRef.set({
      memberUids: FV.arrayUnion(targetUid),
      updatedAt: FV.serverTimestamp()
    }, { merge: true });
  }
  await chanRef.collection('requests').doc(targetUid).set({
    status: approve ? 'approved' : 'denied',
    decidedAt: FV.serverTimestamp(),
    decidedBy: deciderUid
  }, { merge: true });

  await notifyUser(db, targetUid, {
    id: `chandec_${channelKey}_${targetUid}_${approve ? 'a' : 'd'}`,
    type: approve ? 'channel_access_granted' : 'channel_access_denied',
    fromUid: deciderUid,
    fromName: (request.auth.token && request.auth.token.name) || 'The team',
    fromAvatar: null,
    category: channelKey,
    channelName: chan.name || channelKey,
    preview: approve
      ? `You now have access to ${chan.name || channelKey}`
      : `Your request for ${chan.name || channelKey} was not approved`
  }).catch(() => null);

  return { ok: true, approved: approve };
});

/**
 * removeChannelMember({ channelKey, uid }) — owner/admin only.
 *
 * Revokes access going forward. It does NOT retract anything the member already
 * read, and their existing posts stay in the channel.
 */
exports.removeChannelMember = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const channelKey = String((request.data && request.data.channelKey) || '').trim();
  const targetUid = String((request.data && request.data.uid) || '').trim();
  if (!channelKey || !targetUid) {
    throw new HttpsError('invalid-argument', 'channelKey and uid are required.');
  }
  const FV = admin.firestore.FieldValue;
  const chanRef = db.collection('channels').doc(channelKey);
  await chanRef.set({
    memberUids: FV.arrayRemove(targetUid),
    updatedAt: FV.serverTimestamp()
  }, { merge: true });
  // Clear any decided request so they can ask again later.
  try { await chanRef.collection('requests').doc(targetUid).delete(); } catch (e) { /* tolerated */ }
  return { ok: true };
});

// ────────────────────────────────────────────────────────────────
// Search (Stage 2 — topbar search overlay).
//
// Server-side substring match on the latest N posts visible to the
// caller. Bounded by a hard limit so an unbounded query can't drain
// reads. Pairs with the existing searchMembers callable on the
// frontend (called in parallel) to populate the topbar overlay.
// ────────────────────────────────────────────────────────────────

const SEARCH_POSTS_POOL = 200;       // recent posts inspected per call
const SEARCH_POSTS_RESULTS = 10;     // results returned

exports.searchPosts = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const data = request.data || {};
  const q = (data.query || '').toString().trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  if (q.length < 2) return { ok: true, results: [] };

  const isOwnerClaim = request.auth.token && request.auth.token.role === 'owner';
  const db = admin.firestore();

  let callerCompanyId = null;
  if (!isOwnerClaim) {
    try {
      const meSnap = await db.collection('users').doc(callerUid).get();
      if (meSnap.exists) callerCompanyId = meSnap.data().companyId || null;
    } catch (e) { /* tolerated */ }
  }

  const pool = [];
  const seen = new Set();
  function add(d) {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    pool.push({ id: d.id, ...d.data() });
  }

  try {
    if (isOwnerClaim) {
      const snap = await db.collection('posts').orderBy('createdAt', 'desc').limit(SEARCH_POSTS_POOL).get();
      snap.docs.forEach(add);
    } else if (callerCompanyId) {
      const [companySnap, globalSnap] = await Promise.all([
        db.collection('posts').where('companyId', '==', callerCompanyId).orderBy('createdAt', 'desc').limit(SEARCH_POSTS_POOL).get(),
        db.collection('posts').where('companyId', '==', null).orderBy('createdAt', 'desc').limit(SEARCH_POSTS_POOL).get()
      ]);
      companySnap.docs.forEach(add);
      globalSnap.docs.forEach(add);
    } else {
      const snap = await db.collection('posts').where('companyId', '==', null).orderBy('createdAt', 'desc').limit(SEARCH_POSTS_POOL).get();
      snap.docs.forEach(add);
    }
  } catch (err) {
    console.error('[searchPosts] pool fetch failed:', err && err.message);
    return { ok: false, results: [] };
  }

  const results = pool
    .filter((p) => {
      const text = (p.text || '').toLowerCase();
      const author = (p.authorName || '').toLowerCase();
      return text.includes(q) || author.includes(q);
    })
    .sort((a, b) => {
      // Title-text matches first, then author matches; within each group,
      // recency (descending createdAt).
      const at = (a.text || '').toLowerCase().includes(q) ? 0 : 1;
      const bt = (b.text || '').toLowerCase().includes(q) ? 0 : 1;
      if (at !== bt) return at - bt;
      const am = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bm = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return bm - am;
    })
    .slice(0, SEARCH_POSTS_RESULTS)
    .map((p) => ({
      id: p.id,
      text: (p.text || '').slice(0, 200),
      authorName: p.authorName || 'Unknown',
      authorUid: p.authorUid || null,
      authorAvatar: p.authorAvatar || null,
      category: p.category || 'general',
      createdAt: p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis() : null,
      likeCount: p.likeCount || 0,
      commentCount: p.commentCount || 0
    }));

  return { ok: true, results };
});





// ────────────────────────────────────────────────────────────────
// Course commerce — enrollment + Stripe checkout.
//
// Stripe keys are read from the environment at runtime (set them in
// functions/.env or via Secret Manager once a Stripe account exists):
//   STRIPE_SECRET_KEY      — sk_live_... / sk_test_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from the webhook endpoint config)
// Until they're set, paid checkout returns a clear "not configured" error
// while free enrollment keeps working.
// ────────────────────────────────────────────────────────────────

let _stripeClient = null;
function getStripe() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  if (!_stripeClient) {
    // Lazy require so deploys work before the dependency/key are exercised.
    _stripeClient = require('stripe')(key);
  }
  return _stripeClient;
}

async function isAdminCaller(db, request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) return false;
  if (request.auth.token && request.auth.token.role === 'owner') return true;
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists && snap.data().role === 'admin';
}

function effectivePriceDollars(course) {
  const base = typeof course.price === 'number' ? course.price : null;
  const sale = typeof course.salePrice === 'number' && course.salePrice >= 0 ? course.salePrice : null;
  if (sale != null && base != null && sale < base) return sale;
  return base;
}

// enrollFree — server-side enrollment for free (or legacy) courses. All
// client enrollment goes through here; firestore rules freeze
// enrolledCourseSlugs on self-writes.
exports.enrollFree = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const slug = String((request.data && request.data.slug) || '').trim();
  if (!slug) throw new HttpsError('invalid-argument', 'slug is required.');

  const db = admin.firestore();
  const courseSnap = await db.collection('courses').doc(slug).get();
  const course = courseSnap.exists ? courseSnap.data() : null;

  if (!course) throw new HttpsError('not-found', 'Unknown course.');
  if (course.status !== 'live') {
    throw new HttpsError('failed-precondition', 'This course isn\'t available to join yet.');
  }
  const price = effectivePriceDollars(course);
  if (price != null && price > 0) {
    throw new HttpsError('failed-precondition', 'This course requires checkout to enroll.');
  }

  await db.collection('users').doc(uid).set({
    enrolledCourseSlugs: admin.firestore.FieldValue.arrayUnion(slug),
    lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, slug };
});

// createCheckoutSession — starts a Stripe Checkout for a live paid course.
// Price is always read server-side from courses/{slug}; the client only
// sends the slug.
exports.createCheckoutSession = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const slug = String((request.data && request.data.slug) || '').trim();
  if (!slug) throw new HttpsError('invalid-argument', 'slug is required.');

  // Throttle checkout session creation: 15 per user per 10 minutes.
  await rateLimitCaller(admin.firestore(), request,
    { action: 'createCheckoutSession', max: 15, windowSec: 600 });

  const stripe = getStripe();
  if (!stripe) {
    throw new HttpsError('failed-precondition',
      'Online checkout isn\'t available yet — payments are still being set up.');
  }

  const db = admin.firestore();
  const courseSnap = await db.collection('courses').doc(slug).get();
  if (!courseSnap.exists) throw new HttpsError('not-found', 'Unknown course.');
  const course = courseSnap.data();
  if (course.status !== 'live') {
    throw new HttpsError('failed-precondition', 'This course isn\'t available to join yet.');
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const enrolled = (userSnap.exists && userSnap.data().enrolledCourseSlugs) || [];
  if (enrolled.includes(slug)) {
    throw new HttpsError('already-exists', 'You\'re already enrolled in this course.');
  }

  const dollars = effectivePriceDollars(course);
  if (dollars == null || dollars <= 0) {
    throw new HttpsError('failed-precondition', 'This course is free — use enrollFree.');
  }

  const isSubscription = !!(course.pricing && course.pricing.mode === 'subscription');
  const interval = isSubscription
    ? (course.pricing.interval === 'year' ? 'year' : 'month')
    : null;

  // Affiliate attribution — validate the referral code server-side and lock
  // the commission rate into the session metadata at purchase time.
  let refCode = String((request.data && request.data.refCode) || '').trim().toUpperCase();
  let refPercent = null;
  if (refCode) {
    const affSnap = await db.collection('affiliates').doc(refCode).get();
    const aff = affSnap.exists ? affSnap.data() : null;
    const buyerEmail = ((request.auth.token && request.auth.token.email) || '').toLowerCase();
    const selfReferral = aff && (
      (aff.uid && aff.uid === uid)
      || (aff.email && String(aff.email).toLowerCase() === buyerEmail)
    );
    if (aff && aff.active !== false && !selfReferral) {
      refPercent = typeof aff.commissionPercent === 'number' ? aff.commissionPercent : 20;
    } else {
      refCode = '';
    }
  }

  const metadata = { courseSlug: slug, uid };
  if (refCode) {
    metadata.refCode = refCode;
    metadata.refPercent = String(refPercent);
  }

  const priceData = {
    currency: 'usd',
    unit_amount: Math.round(dollars * 100),
    product_data: { name: course.title || slug }
  };
  if (isSubscription) priceData.recurring = { interval };

  const session = await stripe.checkout.sessions.create({
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{ price_data: priceData, quantity: 1 }],
    allow_promotion_codes: true,
    customer_email: (request.auth.token && request.auth.token.email) || undefined,
    client_reference_id: uid,
    metadata,
    ...(isSubscription ? { subscription_data: { metadata } } : {}),
    success_url: `${APP_BASE_URL}/courses.html?course=${encodeURIComponent(slug)}&purchase=success`,
    cancel_url: `${APP_BASE_URL}/courses.html`
  });

  return { ok: true, url: session.url };
});

// stripeWebhook — enrolls buyers after checkout and revokes subscription
// access on cancellation. Configure the endpoint in the Stripe dashboard to
// send: checkout.session.completed, customer.subscription.deleted,
// invoice.payment_failed.
exports.stripeWebhook = onRequest(
  { cors: false, invoker: 'public' },
  async (req, res) => {
    const stripe = getStripe();
    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!stripe || !webhookSecret) {
      console.warn('[stripeWebhook] Stripe not configured');
      res.status(503).send('stripe not configured');
      return;
    }

    let event;
    try {
      const rawBody = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from('');
      event = stripe.webhooks.constructEvent(rawBody, req.get('stripe-signature'), webhookSecret);
    } catch (e) {
      console.warn('[stripeWebhook] signature verification failed:', e && e.message);
      res.status(400).send('invalid signature');
      return;
    }

    const db = admin.firestore();

    // Idempotency: each Stripe event is processed once.
    const evRef = db.collection('stripeEvents').doc(event.id);
    const seen = await evRef.get();
    if (seen.exists) {
      res.status(200).send('ok (duplicate)');
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uid = (session.metadata && session.metadata.uid) || session.client_reference_id;
        const courseSlug = session.metadata && session.metadata.courseSlug;
        if (uid && courseSlug) {
          await db.collection('users').doc(uid).set({
            enrolledCourseSlugs: admin.firestore.FieldValue.arrayUnion(courseSlug)
          }, { merge: true });
          await db.collection('users').doc(uid).collection('purchases').doc(session.id).set({
            courseSlug,
            amount: (session.amount_total || 0) / 100,
            mode: session.mode,
            stripeCustomerId: session.customer || null,
            subscriptionId: session.subscription || null,
            status: session.mode === 'subscription' ? 'active' : 'paid',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          if (session.mode === 'subscription' && session.subscription) {
            // Index for cancellation handling.
            await db.collection('stripeSubscriptions').doc(String(session.subscription)).set({
              uid, courseSlug, sessionId: session.id,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          // Affiliate commission — the code + rate were validated and locked
          // into metadata by createCheckoutSession.
          const refCode = session.metadata && session.metadata.refCode;
          if (refCode) {
            const affRef = db.collection('affiliates').doc(refCode);
            const affSnap = await affRef.get();
            if (affSnap.exists) {
              const pct = Number(session.metadata.refPercent) ||
                (typeof affSnap.data().commissionPercent === 'number' ? affSnap.data().commissionPercent : 20);
              const saleAmount = (session.amount_total || 0) / 100;
              const commission = Math.round(saleAmount * pct) / 100;
              await affRef.collection('referrals').doc(session.id).set({
                courseSlug,
                buyerUid: uid,
                saleAmount,
                commissionPercent: pct,
                commission,
                mode: session.mode,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
              await affRef.set({
                totalSales: admin.firestore.FieldValue.increment(saleAmount),
                totalCommission: admin.firestore.FieldValue.increment(commission),
                saleCount: admin.firestore.FieldValue.increment(1),
                lastSaleAt: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
              await db.collection('users').doc(uid).collection('purchases').doc(session.id)
                .set({ refCode }, { merge: true });
            }
          }

          // ── CRM deal revenue tie-in ──
          // Best-effort: match the buyer to a CRM contact and mark their newest
          // open opportunity as won, recording the paid amount. Non-breaking.
          try {
            let email = (session.customer_details && session.customer_details.email)
              || session.customer_email || null;
            if (!email) {
              const us = await db.collection('users').doc(uid).get();
              email = us.exists ? (us.data().email || null) : null;
            }
            const cid = email ? await resolveAcademyCompanyId(db) : null;
            if (email && cid) {
              const cs = await db.collection('companies').doc(cid).collection('contacts')
                .where('email', '==', email).limit(1).get();
              if (!cs.empty) {
                const contactId = cs.docs[0].id;
                const os = await db.collection('companies').doc(cid).collection('opportunities')
                  .where('contactId', '==', contactId).limit(20).get();
                const open = os.docs.filter((d) => (d.data().status || 'open') === 'open');
                if (open.length) {
                  open.sort((a, b) => {
                    const am = a.data().createdAt && a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0;
                    const bm = b.data().createdAt && b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0;
                    return bm - am;
                  });
                  const pick = open[0];
                  const amount = (session.amount_total || 0) / 100;
                  await pick.ref.set({
                    status: 'won',
                    wonAt: admin.firestore.FieldValue.serverTimestamp(),
                    stripeSessionId: session.id,
                    amountPaid: amount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastActivityAt: admin.firestore.FieldValue.serverTimestamp()
                  }, { merge: true });
                  await db.collection('companies').doc(cid).collection('contacts').doc(contactId)
                    .collection('activities').add({
                      type: 'deal_won',
                      description: `Deal won via Stripe — ${courseSlug} ($${amount})`,
                      actorUid: uid,
                      actorName: 'Stripe',
                      meta: { opportunityId: pick.id, stripeSessionId: session.id, amount },
                      createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
              }
            }
          } catch (e) { console.warn('[stripeWebhook] deal tie-in skipped:', e && e.message); }
        } else {
          console.warn('[stripeWebhook] session missing uid/courseSlug metadata', session.id);
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const idx = await db.collection('stripeSubscriptions').doc(String(sub.id)).get();
        const meta = idx.exists ? idx.data() : (sub.metadata && sub.metadata.uid ? sub.metadata : null);
        if (meta && meta.uid && meta.courseSlug) {
          await db.collection('users').doc(meta.uid).set({
            enrolledCourseSlugs: admin.firestore.FieldValue.arrayRemove(meta.courseSlug)
          }, { merge: true });
          if (meta.sessionId) {
            await db.collection('users').doc(meta.uid).collection('purchases').doc(meta.sessionId)
              .set({ status: 'canceled' }, { merge: true });
          }
        }
      } else if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const idx = await db.collection('stripeSubscriptions').doc(String(subId)).get();
          if (idx.exists && idx.data().sessionId) {
            const meta = idx.data();
            await db.collection('users').doc(meta.uid).collection('purchases').doc(meta.sessionId)
              .set({ status: 'past_due' }, { merge: true });
          }
        }
      }

      await evRef.set({
        type: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(200).send('ok');
    } catch (e) {
      console.error('[stripeWebhook] handler error:', e);
      // Non-2xx so Stripe retries.
      res.status(500).send('handler error');
    }
  }
);

// syncCoupon — mirrors a coupons/{code} doc into a Stripe Coupon +
// Promotion Code so it's redeemable on the checkout page. Admin/owner only.
exports.syncCoupon = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const stripe = getStripe();
  if (!stripe) {
    throw new HttpsError('failed-precondition',
      'Stripe isn\'t configured yet — set STRIPE_SECRET_KEY first.');
  }

  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code) throw new HttpsError('invalid-argument', 'code is required.');
  const ref = db.collection('coupons').doc(code);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Coupon not found.');
  const c = snap.data();
  if (c.stripePromotionCodeId) return { ok: true, alreadySynced: true };

  const couponParams = c.percentOff
    ? { percent_off: Number(c.percentOff) }
    : { amount_off: Math.round(Number(c.amountOff) * 100), currency: 'usd' };
  if (c.expiresAt && c.expiresAt.toDate) {
    couponParams.redeem_by = Math.floor(c.expiresAt.toDate().getTime() / 1000);
  }
  const stripeCoupon = await stripe.coupons.create(couponParams);
  const promo = await stripe.promotionCodes.create({
    coupon: stripeCoupon.id,
    code,
    active: c.active !== false
  });

  await ref.set({
    stripeCouponId: stripeCoupon.id,
    stripePromotionCodeId: promo.id,
    syncedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, promotionCodeId: promo.id };
});

// ────────────────────────────────────────────────────────────────
// Affiliate program — referral codes, click tracking, commissions.
//
// Affiliates live at affiliates/{CODE} (created by owner/admin from
// /manage-affiliates.html). Attribution: links carry ?ref=CODE → stored
// client-side (referral.js) → passed to createCheckoutSession → commission
// recorded by the Stripe webhook. Payouts are manual (mark-as-paid ledger).
// ────────────────────────────────────────────────────────────────

// recordAffiliateClick — public, best-effort click counter for ?ref= visits.
exports.recordAffiliateClick = onCall(async (request) => {
  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code || code.length > 32) return { ok: false };
  const db = admin.firestore();
  // Throttle click inflation: 30 clicks per IP per 10 minutes per code.
  // Fails open on limiter error, and returns a soft {ok:false} on overflow
  // rather than throwing (this is a fire-and-forget beacon from the client).
  try {
    await enforceRateLimit(db, {
      action: 'recordAffiliateClick',
      key: `ip:${clientIp(request)}:${code}`,
      max: 30, windowSec: 600
    });
  } catch (e) {
    if (e instanceof HttpsError) return { ok: false };
    throw e;
  }
  const ref = db.collection('affiliates').doc(code);
  const snap = await ref.get();
  if (!snap.exists || snap.data().active === false) return { ok: false };
  await ref.set({
    clicks: admin.firestore.FieldValue.increment(1),
    lastClickAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});

// markAffiliatePaid — flips all pending referrals for an affiliate to 'paid'
// and rolls the amount into totalPaid. Owner/admin only (the actual payout
// happens outside the platform — bank transfer, PayPal, etc.).
exports.markAffiliatePaid = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code) throw new HttpsError('invalid-argument', 'code is required.');

  const affRef = db.collection('affiliates').doc(code);
  const affSnap = await affRef.get();
  if (!affSnap.exists) throw new HttpsError('not-found', 'Affiliate not found.');

  const pending = await affRef.collection('referrals').where('status', '==', 'pending').get();
  if (pending.empty) return { ok: true, paidCount: 0, paidAmount: 0 };

  let paidAmount = 0;
  const batch = db.batch();
  pending.docs.forEach((d) => {
    paidAmount += d.data().commission || 0;
    batch.set(d.ref, {
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paidBy: (request.auth.token && request.auth.token.email) || request.auth.uid
    }, { merge: true });
  });
  paidAmount = Math.round(paidAmount * 100) / 100;
  batch.set(affRef, {
    totalPaid: admin.firestore.FieldValue.increment(paidAmount)
  }, { merge: true });
  await batch.commit();

  return { ok: true, paidCount: pending.size, paidAmount };
});

// ════════════════════════════════════════════════════════════════
// Scheduled reminder emails (CRM tasks + appointments). Reuse SendGrid.
// Each item is reminded once (remindedAt dedupe). Collection-group queries.
// ════════════════════════════════════════════════════════════════
async function emailForUid(db, uid) {
  if (!uid) return null;
  try {
    const u = await db.collection('users').doc(uid).get();
    return u.exists ? (u.data().email || null) : null;
  } catch (e) { return null; }
}

function reminderHtml(title, lines) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;">
    <h2 style="color:#C8102E;margin:0 0 12px;">${title}</h2>
    ${lines.map((l) => `<p style="font-size:15px;color:#222;margin:6px 0;">${l}</p>`).join('')}
    <p style="font-size:13px;color:#8A8A8A;margin-top:18px;">— Kailey Brown CRM</p>
  </div>`;
}

// NOTE: Scheduled (cron) reminders are temporarily NOT exported because the CI
// deploy service account lacks the "Cloud Scheduler Admin" IAM role
// (cloudscheduler.jobs.update). To re-enable: grant that role to the deploy
// service account in GCP IAM, then rename `_disabled_taskReminders` /
// `_disabled_appointmentReminders` back to `exports.taskReminders` /
// `exports.appointmentReminders` and redeploy.
const _disabled_taskReminders = onSchedule(
  { schedule: 'every 60 minutes', secrets: [sendgridKey] },
  async () => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const horizon = admin.firestore.Timestamp.fromMillis(now.toMillis() + 24 * 3600 * 1000);
    let snap;
    try {
      snap = await db.collectionGroup('tasks')
        .where('status', '==', 'open')
        .where('dueAt', '<=', horizon)
        .limit(200).get();
    } catch (e) { console.warn('[taskReminders] query failed (index?):', e && e.message); return; }
    sgMail.setApiKey(sendgridKey.value());
    let sent = 0;
    for (const d of snap.docs) {
      const t = d.data();
      if (t.remindedAt || !t.dueAt) continue;
      const email = await emailForUid(db, t.assigneeUid);
      if (!email) { await d.ref.set({ remindedAt: now }, { merge: true }); continue; }
      try {
        const due = t.dueAt.toDate ? t.dueAt.toDate() : new Date(t.dueAt);
        await sgMail.send({
          to: email,
          from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
          replyTo: REPLY_TO,
          subject: `Reminder: ${t.title}`,
          html: reminderHtml('Task reminder', [
            `<strong>${t.title}</strong>`,
            t.contactName ? `Contact: ${t.contactName}` : '',
            `Due: ${due.toLocaleString()}`,
            `<a href="${APP_BASE_URL}/tasks.html" style="color:#C8102E;">Open Tasks →</a>`
          ].filter(Boolean)),
          text: `Task reminder: ${t.title} — due ${due.toLocaleString()}`
        });
        sent++;
      } catch (e) { console.warn('[taskReminders] send failed', e && e.message); }
      await d.ref.set({ remindedAt: now }, { merge: true });
    }
    console.log(`[taskReminders] processed ${snap.size}, emailed ${sent}`);
  }
);

const _disabled_appointmentReminders = onSchedule(
  { schedule: 'every 60 minutes', secrets: [sendgridKey] },
  async () => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const horizon = admin.firestore.Timestamp.fromMillis(now.toMillis() + 24 * 3600 * 1000);
    let snap;
    try {
      snap = await db.collectionGroup('appointments')
        .where('status', '==', 'scheduled')
        .where('startAt', '<=', horizon)
        .limit(200).get();
    } catch (e) { console.warn('[appointmentReminders] query failed (index?):', e && e.message); return; }
    sgMail.setApiKey(sendgridKey.value());
    let sent = 0;
    for (const d of snap.docs) {
      const a = d.data();
      if (a.remindedAt || !a.startAt) continue;
      if (a.startAt.toMillis && a.startAt.toMillis() < now.toMillis()) { await d.ref.set({ remindedAt: now }, { merge: true }); continue; }
      const email = await emailForUid(db, a.ownerUid);
      if (!email) { await d.ref.set({ remindedAt: now }, { merge: true }); continue; }
      try {
        const start = a.startAt.toDate ? a.startAt.toDate() : new Date(a.startAt);
        await sgMail.send({
          to: email,
          from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
          replyTo: REPLY_TO,
          subject: `Upcoming: ${a.title}`,
          html: reminderHtml('Appointment reminder', [
            `<strong>${a.title}</strong>`,
            a.contactName ? `With: ${a.contactName}` : '',
            `When: ${start.toLocaleString()}`,
            a.location ? `Where: ${a.location}` : '',
            `<a href="${APP_BASE_URL}/calendar.html" style="color:#C8102E;">Open Calendar →</a>`
          ].filter(Boolean)),
          text: `Appointment: ${a.title} at ${start.toLocaleString()}`
        });
        sent++;
      } catch (e) { console.warn('[appointmentReminders] send failed', e && e.message); }
      await d.ref.set({ remindedAt: now }, { merge: true });
    }
    console.log(`[appointmentReminders] processed ${snap.size}, emailed ${sent}`);
  }
);

// ════════════════════════════════════════════════════════════════
// Twilio 2-way SMS — send (callable) + inbound/status webhooks.
// Conversations live at companies/{cid}/conversations/{contactId} with a
// messages subcollection (written only here, via Admin SDK).
// ════════════════════════════════════════════════════════════════
exports.sendSms = onCall(
  async (request) => {
    const db = admin.firestore();
    const { companyId, contactId, body } = request.data || {};
    if (!companyId || !contactId || !body) {
      throw new HttpsError('invalid-argument', 'companyId, contactId and body are required.');
    }
    await assertCompanyAdmin(db, companyId, request);

    // Throttle outbound SMS: 100 per admin per 10 minutes.
    await rateLimitCaller(db, request, { action: 'sendSms', max: 100, windowSec: 600 });

    const client = getTwilio();
    const from = (process.env.TWILIO_FROM_NUMBER || '').trim();
    if (!client || !from) {
      throw new HttpsError('failed-precondition', 'SMS is not configured yet. Add the Twilio secrets first.');
    }

    const cRef = db.collection('companies').doc(companyId).collection('contacts').doc(contactId);
    const cSnap = await cRef.get();
    if (!cSnap.exists) throw new HttpsError('not-found', 'Contact not found.');
    const to = normalizePhone(cSnap.data().phone);
    if (!to) throw new HttpsError('failed-precondition', 'Contact has no phone number.');
    // TCPA opt-out: never message a contact who has replied STOP.
    if (cSnap.data().smsOptedOut === true) {
      throw new HttpsError('failed-precondition',
        'This contact has opted out of SMS (replied STOP) and cannot be messaged.');
    }

    let msg;
    try {
      msg = await client.messages.create({ to, from, body: String(body).slice(0, 1600) });
    } catch (e) {
      throw new HttpsError('internal', 'Twilio send failed: ' + (e && e.message));
    }

    const FV = admin.firestore.FieldValue;
    const convRef = db.collection('companies').doc(companyId).collection('conversations').doc(contactId);
    await convRef.set({
      contactId, contactPhone: to, channel: 'sms',
      lastMessageAt: FV.serverTimestamp(), lastMessageText: String(body).slice(0, 200), lastDirection: 'out',
      updatedAt: FV.serverTimestamp(), createdAt: FV.serverTimestamp()
    }, { merge: true });
    await convRef.collection('messages').doc(msg.sid).set({
      direction: 'out', body: String(body), fromNumber: from, toNumber: to,
      status: msg.status || 'sent', twilioSid: msg.sid, sentByUid: request.auth.uid,
      createdAt: FV.serverTimestamp()
    });
    await cRef.collection('activities').add({
      type: 'manual_sms', description: 'SMS sent: ' + String(body).slice(0, 120),
      actorUid: request.auth.uid, actorName: 'You', createdAt: FV.serverTimestamp(), meta: { direction: 'out' }
    });
    await cRef.set({ lastActivityAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true, sid: msg.sid, status: msg.status || 'sent' };
  }
);

exports.twilioInboundWebhook = onRequest(
  { cors: false, invoker: 'public' },
  async (req, res) => {
    const db = admin.firestore();
    const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    // Signature validation — reject anything not signed by Twilio.
    try {
      const twilioLib = require('twilio');
      const signature = req.get('X-Twilio-Signature') || '';
      const url = `https://${req.get('host')}${req.originalUrl}`;
      if (!token || !twilioLib.validateRequest(token, signature, url, req.body || {})) {
        res.status(403).send('invalid signature');
        return;
      }
    } catch (e) { res.status(403).send('signature error'); return; }

    const from = normalizePhone(req.body.From);
    const to = normalizePhone(req.body.To);
    const text = req.body.Body || '';
    const sid = req.body.MessageSid || ('in_' + Date.now());

    try {
      const cid = await resolveAcademyCompanyId(db);
      if (cid && from) {
        const FV = admin.firestore.FieldValue;
        const contactsRef = db.collection('companies').doc(cid).collection('contacts');
        let contactDoc = null;
        const q1 = await contactsRef.where('phone', '==', from).limit(1).get();
        if (!q1.empty) contactDoc = q1.docs[0];
        if (!contactDoc) {
          const newRef = await contactsRef.add({
            name: from, email: null, phone: from, companyName: null,
            source: 'SMS', stage: 'new', tags: [], ownerUid: null,
            createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
            createdBy: 'twilio', lastActivityAt: FV.serverTimestamp()
          });
          contactDoc = await newRef.get();
        }
        const contactId = contactDoc.id;
        const convRef = db.collection('companies').doc(cid).collection('conversations').doc(contactId);
        await convRef.set({
          contactId, contactPhone: from, channel: 'sms',
          lastMessageAt: FV.serverTimestamp(), lastMessageText: String(text).slice(0, 200), lastDirection: 'in',
          unreadCount: FV.increment(1), updatedAt: FV.serverTimestamp(), createdAt: FV.serverTimestamp()
        }, { merge: true });
        await convRef.collection('messages').doc(sid).set({
          direction: 'in', body: String(text), fromNumber: from, toNumber: to,
          status: 'received', twilioSid: sid, createdAt: FV.serverTimestamp()
        });
        await contactDoc.ref.collection('activities').add({
          type: 'sms_received', description: 'SMS received: ' + String(text).slice(0, 120),
          actorUid: 'twilio', actorName: from, createdAt: FV.serverTimestamp(), meta: { direction: 'in' }
        });

        // ── TCPA opt-out / opt-in keyword handling ──────────────────────────
        // Carriers honor STOP at the network level, but we must also record it
        // so our own sendSms/sendCampaign never message an opted-out number.
        const kw = String(text).trim().toUpperCase().replace(/[^A-Z]/g, '');
        const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'];
        const START_WORDS = ['START', 'YES', 'UNSTOP', 'OPTIN'];
        if (STOP_WORDS.includes(kw)) {
          await contactDoc.ref.set({
            smsOptedOut: true, smsOptedOutAt: FV.serverTimestamp()
          }, { merge: true });
          await contactDoc.ref.collection('activities').add({
            type: 'sms_opt_out', description: 'Contact opted OUT of SMS (replied ' + kw + ').',
            actorUid: 'twilio', actorName: from, createdAt: FV.serverTimestamp(), meta: { keyword: kw }
          });
        } else if (START_WORDS.includes(kw)) {
          await contactDoc.ref.set({
            smsOptedOut: false, smsOptedInAt: FV.serverTimestamp()
          }, { merge: true });
          await contactDoc.ref.collection('activities').add({
            type: 'sms_opt_in', description: 'Contact opted IN to SMS (replied ' + kw + ').',
            actorUid: 'twilio', actorName: from, createdAt: FV.serverTimestamp(), meta: { keyword: kw }
          });
        }

        await contactDoc.ref.set({ lastActivityAt: FV.serverTimestamp() }, { merge: true });
      }
    } catch (e) { console.warn('[twilioInbound]', e && e.message); }

    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
);

exports.twilioStatusWebhook = onRequest(
  { cors: false, invoker: 'public' },
  async (req, res) => {
    const db = admin.firestore();
    const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    try {
      const twilioLib = require('twilio');
      const signature = req.get('X-Twilio-Signature') || '';
      const url = `https://${req.get('host')}${req.originalUrl}`;
      if (!token || !twilioLib.validateRequest(token, signature, url, req.body || {})) {
        res.status(403).send('invalid signature');
        return;
      }
    } catch (e) { res.status(403).send('signature error'); return; }

    const sid = req.body.MessageSid;
    const status = req.body.MessageStatus;
    if (sid && status) {
      try {
        const ms = await db.collectionGroup('messages').where('twilioSid', '==', sid).limit(1).get();
        if (!ms.empty) await ms.docs[0].ref.set({ status }, { merge: true });
      } catch (e) { console.warn('[twilioStatus] (index?)', e && e.message); }
    }
    res.status(200).send('ok');
  }
);

// ════════════════════════════════════════════════════════════════
// Product interest / pre-order signals + early-access list.
// Public callables (allow unauthenticated) that upsert a CRM contact and
// tag them, so demand can be gauged and emailed via existing campaigns.
// ════════════════════════════════════════════════════════════════

// registerProductInterest({ productId, name, email, phone, consent })
exports.registerProductInterest = onCall(async (request) => {
  const db = admin.firestore();
  const data = request.data || {};
  const productId = (data.productId || '').toString().trim();
  const name = (data.name || '').toString().trim().slice(0, 120);
  const email = (data.email || '').toString().trim().toLowerCase().slice(0, 160);
  const phone = (data.phone || '').toString().trim().slice(0, 40) || null;
  const consent = !!data.consent;
  if (!productId) throw new HttpsError('invalid-argument', 'Missing product.');
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email.');

  const prodRef = db.collection('products').doc(productId);
  const prodSnap = await prodRef.get();
  if (!prodSnap.exists) throw new HttpsError('not-found', 'Product not found.');
  const product = prodSnap.data();
  const FV = admin.firestore.FieldValue;
  const uid = (request.auth && request.auth.uid) || null;

  // Dedupe interest by email (doc id = sanitized email).
  const interestId = email.replace(/[^a-z0-9]/g, '_').slice(0, 120);
  const intRef = prodRef.collection('interests').doc(interestId);
  const existing = await intRef.get();
  const isNew = !existing.exists;
  await intRef.set({
    name: name || null, email, phone, uid, consent,
    createdAt: existing.exists ? existing.data().createdAt : FV.serverTimestamp(),
    updatedAt: FV.serverTimestamp()
  }, { merge: true });
  if (isNew) await prodRef.set({ interestCount: FV.increment(1) }, { merge: true });

  // Upsert into the CRM (best-effort).
  try {
    const companyId = await resolveAcademyCompanyId(db);
    if (companyId) {
      const tags = [`Interest: ${product.name}`.slice(0, 40)];
      if (consent) tags.push('Opt-In: Calls/SMS/Email');
      const ref = await upsertCrmContact(db, companyId, {
        name: name || null, email, phone, source: 'Product Interest', tags
      });
      if (consent) {
        await ref.set({
          marketingConsent: true, marketingConsentAt: FV.serverTimestamp(),
          marketingConsentText: 'Opted in via product interest form'
        }, { merge: true });
      }
      await ref.collection('activities').add({
        type: 'product_interest', description: `Interested in "${product.name}"`,
        actorUid: 'system', actorName: 'Product interest',
        createdAt: FV.serverTimestamp(), meta: { productId, productName: product.name }
      });
    }
  } catch (e) { console.warn('[registerProductInterest] CRM upsert failed:', e && e.message); }

  return { ok: true, alreadyJoined: !isNew, count: (product.interestCount || 0) + (isNew ? 1 : 0) };
});

// joinEarlyAccess({ name, email, consent, source }) — general mailing-list capture.
//
// `source` labels where the signup came from so the CRM can tell a newsletter
// subscriber apart from someone waiting on a specific launch. It is echoed into
// the contact's source field, its tag, and the consent record, so the audit
// trail says what the person actually agreed to. Unknown values fall back to
// the early-access default rather than being trusted verbatim.
const SIGNUP_SOURCES = {
  'newsletter':    { label: 'Newsletter',    activity: 'Subscribed to the newsletter' },
  'early-access':  { label: 'Early Access',  activity: 'Joined the early-access list' }
};

exports.joinEarlyAccess = onCall(async (request) => {
  const db = admin.firestore();
  const data = request.data || {};
  const name = (data.name || '').toString().trim().slice(0, 120);
  const email = (data.email || '').toString().trim().toLowerCase().slice(0, 160);
  const consent = !!data.consent;
  const src = SIGNUP_SOURCES[(data.source || '').toString()] || SIGNUP_SOURCES['early-access'];
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email.');

  // Throttle: this is unauthenticated, so it is rate limited by IP.
  await rateLimitCaller(db, request, { action: 'joinEarlyAccess', max: 20, windowSec: 600 });

  try {
    const companyId = await resolveAcademyCompanyId(db);
    if (companyId) {
      const FV = admin.firestore.FieldValue;
      const tags = [src.label];
      if (consent) tags.push('Opt-In: Calls/SMS/Email');
      const ref = await upsertCrmContact(db, companyId, { name: name || null, email, source: src.label, tags });
      if (consent) {
        // Prefer the exact wording the person saw, so the consent record can be
        // defended later. Falls back to a generic line if the client sent none.
        const shownText = (data.consentText || '').toString().trim().slice(0, 500);
        await ref.set({
          marketingConsent: true, marketingConsentAt: FV.serverTimestamp(),
          marketingConsentText: shownText || `Opted in via the ${src.label.toLowerCase()} form`
        }, { merge: true });
      }
      await ref.collection('activities').add({
        type: 'signup', description: src.activity,
        actorUid: 'system', actorName: src.label, createdAt: FV.serverTimestamp()
      });
    }
  } catch (e) { console.warn('[joinEarlyAccess]', e && e.message); }
  return { ok: true };
});

// Email everyone on a product's interest list that it's live.
async function sendProductLaunchEmails(db, productId, product) {
  const intsnap = await db.collection('products').doc(productId).collection('interests').get();
  const recipients = [];
  intsnap.forEach((d) => { const e = d.data().email; if (e && EMAIL_RE.test(e)) recipients.push(e); });
  if (!recipients.length) return 0;
  sgMail.setApiKey(sendgridKey.value());
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;">
    <h2 style="color:#C8102E;margin:0 0 10px;">It's here: ${product.name}</h2>
    <p style="font-size:15px;color:#222;">You asked to be the first to know — ${product.name} is now available.</p>
    ${product.summary ? `<p style="font-size:14px;color:#444;">${product.summary}</p>` : ''}
    <p style="margin:18px 0;"><a href="${APP_BASE_URL}" style="background:#C8102E;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Check it out →</a></p>
    <p style="font-size:12px;color:#8A8A8A;">— Kailey Brown</p>
  </div>`;
  let sent = 0;
  for (let i = 0; i < recipients.length; i += 900) {
    const chunk = recipients.slice(i, i + 900);
    try {
      await sgMail.send({
        from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT }, replyTo: REPLY_TO,
        subject: `It's here: ${product.name}`, html,
        text: `${product.name} is now available. Visit ${APP_BASE_URL}`,
        isMultiple: true,
        personalizations: chunk.map((to) => ({ to }))
      });
      sent += chunk.length;
    } catch (e) { console.warn('[productLaunch] send failed', e && e.message); }
  }
  return sent;
}

// When a product flips to "live", auto-email its interest list once.
exports.onProductWritten = onDocumentWritten(
  { document: 'products/{productId}', secrets: [sendgridKey] },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    if (!after) return;
    const becameLive = after.status === 'live' && (!before || before.status !== 'live');
    if (!becameLive || after.launchNotifiedAt) return;
    const db = admin.firestore();
    const productId = event.params.productId;
    try {
      const n = await sendProductLaunchEmails(db, productId, after);
      await db.collection('products').doc(productId).set({
        launchNotifiedAt: admin.firestore.FieldValue.serverTimestamp(), launchNotifiedCount: n
      }, { merge: true });
    } catch (e) { console.warn('[onProductWritten]', e && e.message); }
  }
);

// Manual "Notify list" button (admin) — backup for the auto trigger.
exports.notifyProductInterest = onCall({ secrets: [sendgridKey] }, async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) throw new HttpsError('permission-denied', 'Admin or owner role required.');
  const productId = (request.data && request.data.productId || '').toString();
  const snap = await db.collection('products').doc(productId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found.');
  const n = await sendProductLaunchEmails(db, productId, snap.data());
  return { ok: true, sent: n };
});

// ════════════════════════════════════════════════════════════════
// Course Advisor Chatbot — powered by Claude (Anthropic).
//
// courseAdvisorChat({ message, history }) → { reply, sessionId }
//
// Public callers (no auth) get general course info and brand mission guidance.
// Authenticated callers get their profile + enrolled courses injected into the
// system prompt for personalised recommendations.
//
// When the user expresses intent to suggest a new course topic the function
// saves a courseSuggestions/{id} doc and acknowledges receipt.
// ════════════════════════════════════════════════════════════════

// The chatbot's view of the catalog. The source repo hardcoded a second copy
// of the course list here, which had no automatic sync with the client-side
// registry and silently drifted. This reads the live catalog from Firestore
// instead, so admins editing courses in the CMS never leave the chatbot stale.
// Fails soft: on any read error the assistant simply has no course list.
async function loadCourseCatalog(db) {
  try {
    const snap = await db.collection('courses').where('status', '==', 'live').get();
    return snap.docs.map((d) => {
      const c = d.data() || {};
      return {
        slug:    d.id,
        title:   c.title || d.id,
        price:   effectivePriceDollars(c),
        modules: c.moduleCount != null ? c.moduleCount : null,
        eyebrow: c.eyebrow || '',
        desc:    c.description || ''
      };
    });
  } catch (e) {
    console.warn('[courseAdvisorChat] loadCourseCatalog failed:', e && e.message);
    return [];
  }
}

function buildCourseKnowledge(courses) {
  if (!courses || !courses.length) return '(No courses are published yet.)';
  return courses.map((c) => {
    const bits = [c.eyebrow, c.modules != null ? `${c.modules} modules` : null,
                  c.price != null ? `$${c.price}` : null].filter(Boolean).join(' \u00b7 ');
    return `- ${c.title}${bits ? ` (${bits})` : ''}${c.desc ? `: ${c.desc}` : ''}`;
  }).join('\n');
}

function buildSystemPrompt(userContext, knowledgeEntries, communityContext, courses, books) {
  const courseList = buildCourseKnowledge(courses);
  const bookSection = buildBookKnowledge(books);

  // Inject owner-supplied knowledge base entries
  let kbSection = '';
  if (knowledgeEntries && knowledgeEntries.length) {
    const items = knowledgeEntries
      .map((e) => `### ${e.title}\n${e.body}`)
      .join('\n\n');
    kbSection = `\n\nADDITIONAL KNOWLEDGE BASE:\n${items}`;
  }

  const base = `You are the Reading Room — the book concierge for author Kailey Brown. Your first job is helping readers with her books: which one to start with, where to buy or download a copy, what a title is about (without spoiling it), reading guides and book-club questions, signed copies and events, release dates for what's coming next, and the free resources and downloads that accompany each book. You also support members of the Kailey Brown Academy portal with courses and their progress, but reader questions come first.

The Kailey Brown mission is to help people grow with clarity and intention, through stories that stay with them.

BOOK-RELATED HELP — what readers most often need:
- WHERE TO START: ask what they tend to enjoy, then recommend one title and say in a sentence why it suits them. Recommend one, not a list.
- GETTING A COPY: point to the buy links on the site's Books section, and mention ebook/audio if a format is listed in the knowledge base.
- SPOILERS: never reveal endings or late-book twists unless the reader explicitly says they have finished the book and want to discuss it.
- BOOK CLUBS: offer discussion questions, themes, and pacing suggestions. You may generate thoughtful questions yourself when no official guide exists — say when they are yours rather than an official guide.
- RESOURCES: reading guides, bonus scenes, playlists, newsletter (the Inner Circle), events and signings. If you are not certain something exists, say so plainly and point them to the Inner Circle newsletter or the contact address rather than inventing a resource, a link, a price, or a release date.
- NEXT BOOK: share only what the knowledge base states. Never guess at a release date.

${bookSection}

AVAILABLE COURSES (secondary — for portal members):
${courseList}${kbSection}

GUIDELINES:
- Maintain a warm, literary tone aligned with the Kailey Brown voice — like a well-read bookseller who knows these titles, not a support bot.
- Keep responses focused and actionable — avoid long walls of text.
- Never invent book titles, plot details, purchase links, prices, dates, or resources that are not in your knowledge above. Saying "I'm not sure — let me point you to the Inner Circle newsletter" is always better than guessing.
- When recommending courses, briefly explain WHY a specific course fits the member's stated goal.
- You never share other members' data or progress information.
- If a member suggests a new course topic or learning area they wish Kailey Brown offered, acknowledge their suggestion enthusiastically, ask 1-2 clarifying questions about their learning goals and preferred outcomes, then tell them you've submitted their suggestion to the course team. Use the keyword COURSE_SUGGESTION_DETECTED in your response ONLY when you have gathered enough context (after the clarifying exchange) and are ready to log the suggestion — wrap the full suggestion detail in JSON after that keyword like: COURSE_SUGGESTION_DETECTED{"topic":"...","goals":"...","outcomes":"..."}`;

  if (!userContext) {
    return base + '\n\nCONTEXT: You are speaking with a visitor on the public website. They are not yet logged in.';
  }

  const { displayName, enrolledCourses, progressSummary, bio, profession, location } = userContext;
  const name = displayName ? `Their name is ${displayName}.` : '';
  const enrolled = enrolledCourses && enrolledCourses.length
    ? `They are currently enrolled in: ${enrolledCourses.join(', ')}.`
    : 'They are not yet enrolled in any courses.';
  const progress = progressSummary || '';

  // Build profile snapshot for context
  const profileParts = [];
  if (displayName) profileParts.push(`Name: ${displayName}`);
  if (bio)         profileParts.push(`Bio: ${bio}`);
  if (profession)  profileParts.push(`Profession: ${profession}`);
  if (location)    profileParts.push(`Location: ${location}`);
  const profileSnapshot = profileParts.length
    ? `\nMEMBER PROFILE:\n${profileParts.map(p => `- ${p}`).join('\n')}`
    : '';

  const communitySection = communityContext
    ? `\n\nCOMMUNITY SNAPSHOT (last 7 days):\n${communityContext}`
    : '';

  const portalInstructions = `

PORTAL CAPABILITIES (authenticated members only):
1. PROFILE UPDATES — If the member asks to update their display name, bio, profession, company, industry, location, LinkedIn URL, website, phone, community goals, or pronouns: confirm what they want, then output PROFILE_UPDATE immediately followed by a compact JSON object with ONLY the fields being changed. Example: PROFILE_UPDATE{"bio":"I'm a leadership coach in Atlanta"}. Never include this signal for fields not in that list (role, email, avatar, etc.). Strip any other commentary from the signal line — just the keyword and JSON. After the signal, confirm what was updated in natural language.
2. COMMUNITY UPDATES — When asked "what's new", "any updates", "what's happening in the community", or similar: summarize the COMMUNITY SNAPSHOT above. Lead with announcements, then highlight wins. Keep it to 3–5 sentences. If the snapshot is empty, say "Check the Community tab for the latest — I don't have a live feed right now."`;

  return `${base}${profileSnapshot}${communitySection}${portalInstructions}\n\nCONTEXT: You are speaking with an authenticated member inside the Kailey Brown Academy portal. ${name} ${enrolled} ${progress}`.trim();
}

async function fetchMemberContext(db, uid, courses) {
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return null;
    const u = userSnap.data();

    const enrolledCourses = (u.enrolledCourseSlugs || []).map((slug) => {
      const course = (courses || []).find((c) => c.slug === slug);
      return course ? course.title : slug;
    });

    // Fetch up to 5 most recently active course progress docs.
    let progressSummary = '';
    try {
      const progSnap = await db.collection('users').doc(uid).collection('courseProgress')
        .orderBy('lastActiveAt', 'desc').limit(5).get();
      if (!progSnap.empty) {
        const parts = progSnap.docs.map((d) => {
          const p = d.data();
          const course = (courses || []).find((c) => c.slug === d.id);
          const name = course ? course.title : d.id;
          const pct = p.progressPct != null ? `${Math.round(p.progressPct)}% complete` : '';
          const mod = p.currentModule ? `on module ${p.currentModule}` : '';
          return [name, pct, mod].filter(Boolean).join(', ');
        });
        if (parts.length) progressSummary = `Progress: ${parts.join(' | ')}.`;
      }
    } catch (e) { /* progress subcollection may not exist yet */ }

    return {
      displayName:   u.displayName   || null,
      bio:           u.bio           || null,
      profession:    u.profession    || null,
      location:      u.location      || null,
      companyId:     u.companyId     || null,
      enrolledCourses,
      progressSummary
    };
  } catch (e) {
    console.warn('[courseAdvisorChat] fetchMemberContext failed:', e && e.message);
    return null;
  }
}

// Fetch all active knowledge base entries (ordered by pinned desc, then order asc).
async function fetchKnowledgeEntries(db) {
  try {
    const snap = await db.collection('chatbotKnowledge')
      .where('active', '==', true)
      .orderBy('order', 'asc')
      .limit(50)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[courseAdvisorChat] fetchKnowledgeEntries failed:', e && e.message);
    return [];
  }
}

// Fetch recent community posts visible to this member for chatbot context.
async function fetchCommunityContext(db, companyId) {
  try {
    // Single query ordered by date — no composite index needed.
    const snap = await db.collection('posts').orderBy('createdAt', 'desc').limit(25).get();

    function relTime(ts) {
      if (!ts || !ts.toMillis) return '';
      const m = Math.floor((Date.now() - ts.toMillis()) / 60000);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    }

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - sevenDaysMs;

    // Visibility: global posts (companyId null/undefined) + member's company posts.
    const visible = snap.docs.filter((d) => {
      const cid = d.data().companyId;
      if (!cid) return true;
      return companyId && cid === companyId;
    }).filter((d) => {
      const ts = d.data().createdAt;
      return ts && ts.toMillis && ts.toMillis() > cutoff;
    });

    const byCategory = { announcements: [], wins: [], other: [] };
    visible.forEach((d) => {
      const cat = d.data().category || 'other';
      if (cat === 'announcements') byCategory.announcements.push(d);
      else if (cat === 'wins')     byCategory.wins.push(d);
      else                         byCategory.other.push(d);
    });

    function fmt(d) {
      const data = d.data();
      const text = String(data.text || '').trim();
      const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
      const when = relTime(data.createdAt);
      const author = data.authorName || 'Member';
      return `"${preview}" — ${author}${when ? ` (${when})` : ''}`;
    }

    const lines = [];
    if (byCategory.announcements.length) {
      lines.push('📣 ANNOUNCEMENTS:');
      byCategory.announcements.slice(0, 3).forEach((d) => lines.push(`  - ${fmt(d)}`));
    }
    if (byCategory.wins.length) {
      lines.push('🏆 WINS & HIGHLIGHTS:');
      byCategory.wins.slice(0, 3).forEach((d) => lines.push(`  - ${fmt(d)}`));
    }
    if (byCategory.other.length) {
      lines.push('💬 RECENT ACTIVITY:');
      byCategory.other.slice(0, 3).forEach((d) => lines.push(`  - ${fmt(d)}`));
    }

    return lines.length ? lines.join('\n') : null;
  } catch (e) {
    console.warn('[courseAdvisorChat] fetchCommunityContext failed:', e && e.message);
    return null;
  }
}

// Allowed fields for PROFILE_UPDATE signal — whitelist keeps sensitive fields safe.
const PROFILE_UPDATE_ALLOWED = {
  displayName: 100, bio: 500, profession: 150, company: 150,
  industry: 100, location: 150, linkedinUrl: 300, website: 300,
  phone: 40, communityGoals: 1000, pronouns: 50
};

// saveKnowledgeEntry — create or update a KB entry. Owner/admin only.
exports.saveKnowledgeEntry = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const { id, title, body, order, active } = request.data || {};
  if (!title || !title.trim()) throw new HttpsError('invalid-argument', 'title is required.');
  if (!body  || !body.trim())  throw new HttpsError('invalid-argument', 'body is required.');

  const payload = {
    title:     String(title).trim().slice(0, 200),
    body:      String(body).trim().slice(0, 8000),
    order:     typeof order === 'number' ? order : 0,
    active:    active !== false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid
  };

  if (id) {
    // Update existing
    const ref = db.collection('chatbotKnowledge').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Entry not found.');
    await ref.set(payload, { merge: true });
    return { ok: true, id };
  } else {
    // Create new
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    payload.createdBy = request.auth.uid;
    const ref = await db.collection('chatbotKnowledge').add(payload);
    return { ok: true, id: ref.id };
  }
});

// deleteKnowledgeEntry — hard-delete a KB entry. Owner/admin only.
exports.deleteKnowledgeEntry = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const id = String((request.data && request.data.id) || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');
  await db.collection('chatbotKnowledge').doc(id).delete();
  return { ok: true };
});

// listKnowledgeEntries — returns all entries (incl. inactive). Owner/admin only.
exports.listKnowledgeEntries = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const snap = await db.collection('chatbotKnowledge').orderBy('order', 'asc').limit(200).get();
  return {
    entries: snap.docs.map((d) => ({ id: d.id, ...d.data(),
      createdAt: d.data().createdAt ? d.data().createdAt.toMillis() : null,
      updatedAt: d.data().updatedAt ? d.data().updatedAt.toMillis() : null
    }))
  };
});

// ════════════════════════════════════════════════════════════════
// THE BOOK SHELF
//
// Where readers can buy the books is the single most common question the
// Reading Room gets, and it is exactly the kind of fact a language model
// will cheerfully invent if you leave it to guess. So the buy links live
// here as owner-entered data, and the assistant is handed them verbatim
// with instructions never to produce a link that is not on this list.
//
// This is deliberately its own collection rather than more free-text
// chatbotKnowledge entries: the fields are known in advance (ISBN, format,
// retailer, price, release date), so storing them as structure means the
// prompt builder can present them consistently, and a future storefront
// page can read the same documents.
// ════════════════════════════════════════════════════════════════

const BOOK_STATUSES = ['out_now', 'preorder', 'coming_soon'];
const BOOK_TEXT_FIELDS = {
  title: 200, subtitle: 200, series: 120, blurb: 4000, genre: 160,
  tropes: 500, contentNotes: 1000, readingOrderNote: 400,
  isbn13: 20, isbn10: 20, asin: 20, publisher: 160, language: 60,
  coverUrl: 600
};

// Only http(s) survives. A javascript: or data: URL stored here would be
// handed to readers as a "buy link" and rendered by whatever consumes it.
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch (e) { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.toString().slice(0, 600);
}

function sanitizeLinkRows(rows, fields, max = 20) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, max).map((row) => {
    const out = {};
    for (const [key, limit] of Object.entries(fields)) {
      out[key] = String((row && row[key]) || '').trim().slice(0, limit);
    }
    out.url = safeUrl(row && row.url);
    return out;
  }).filter((row) => row.url || row.label || row.retailer);
}

function sanitizeBookPayload(data) {
  const book = {};
  for (const [field, limit] of Object.entries(BOOK_TEXT_FIELDS)) {
    book[field] = String((data && data[field]) || '').trim().slice(0, limit);
  }
  book.coverUrl = safeUrl(data && data.coverUrl);
  book.status = BOOK_STATUSES.includes(data && data.status) ? data.status : 'out_now';
  // Kept as a plain YYYY-MM-DD string, not a Timestamp: it goes straight into
  // a prompt, and a Timestamp would arrive there as a timezone-shifted
  // datetime that reads as the wrong day to readers in half the world.
  const rawDate = String((data && data.releaseDate) || '').trim();
  book.releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';
  book.seriesNumber = Number.isFinite(Number(data && data.seriesNumber)) && data.seriesNumber !== ''
    ? Math.max(0, Math.min(99, Math.round(Number(data.seriesNumber))))
    : null;
  book.pageCount = Number.isFinite(Number(data && data.pageCount)) && data.pageCount !== ''
    ? Math.max(0, Math.min(20000, Math.round(Number(data.pageCount))))
    : null;
  book.order = Number.isFinite(Number(data && data.order)) ? Math.round(Number(data.order)) : 0;
  book.active = (data && data.active) !== false;
  book.buyLinks = sanitizeLinkRows(data && data.buyLinks,
    { retailer: 120, format: 60, price: 40, currency: 10, note: 200 });
  book.resources = sanitizeLinkRows(data && data.resources, { label: 160, note: 300 });
  return book;
}

// saveBook — create or update a book. Owner/admin only.
exports.saveBook = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const data = request.data || {};
  if (!data.title || !String(data.title).trim()) {
    throw new HttpsError('invalid-argument', 'title is required.');
  }

  const payload = sanitizeBookPayload(data);
  payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  payload.updatedBy = request.auth.uid;

  if (data.id) {
    const ref = db.collection('books').doc(String(data.id));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Book not found.');
    await ref.set(payload, { merge: true });
    return { ok: true, id: ref.id };
  }
  payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  payload.createdBy = request.auth.uid;
  const ref = await db.collection('books').add(payload);
  return { ok: true, id: ref.id };
});

// deleteBook — hard-delete. Owner/admin only.
exports.deleteBook = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const id = String((request.data && request.data.id) || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');
  await db.collection('books').doc(id).delete();
  return { ok: true };
});

// listBooks — every book, including inactive ones. Owner/admin only.
exports.listBooks = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const snap = await db.collection('books').orderBy('order', 'asc').limit(200).get();
  return {
    books: snap.docs.map((d) => {
      const b = d.data() || {};
      return { id: d.id, ...b,
        createdAt: b.createdAt ? b.createdAt.toMillis() : null,
        updatedAt: b.updatedAt ? b.updatedAt.toMillis() : null };
    })
  };
});

// ── Metadata lookup ──────────────────────────────────────────────────────
//
// "Sync my Amazon and publishing info" in the form it can actually take
// today. Google Books and Open Library are queried by ISBN (or title) and
// need no credentials, so this works the moment it deploys; between them
// they cover publisher, page count, categories, cover art and the matching
// ISBN-10/13 pair.
//
// Amazon's own catalog is NOT one of these. Its Product Advertising API
// requires an approved Associates account and signed requests, and scraping
// the storefront violates its terms — so Amazon arrives here as a product
// URL built from the ISBN-10 (which IS the ASIN for most print books), and
// the other retailers as search URLs. They are proposals: the owner sees
// every one in the form and saves it only after checking it resolves.
//
// Requires the Blaze plan — outbound network calls are blocked on Spark.
async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[lookupBookMetadata] fetch failed:', url, e && e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isbn13to10(isbn13) {
  const digits = String(isbn13 || '').replace(/[^0-9X]/gi, '');
  if (digits.length !== 13 || !digits.startsWith('978')) return '';
  const core = digits.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

function buildRetailerSuggestions({ isbn13, isbn10, asin, title }) {
  const links = [];
  const amazonId = String(asin || isbn10 || '').trim();
  const term = encodeURIComponent(isbn13 || title || '');
  if (amazonId) {
    links.push({ retailer: 'Amazon', format: '', price: '', currency: '',
      note: 'Auto-built from the ASIN/ISBN-10 — open it once to confirm.',
      url: `https://www.amazon.com/dp/${encodeURIComponent(amazonId)}` });
  }
  if (isbn13 || title) {
    links.push({ retailer: 'Bookshop.org', format: '', price: '', currency: '',
      note: 'Search link — replace with the direct product URL when you have it.',
      url: `https://bookshop.org/search?keywords=${term}` });
    links.push({ retailer: 'Barnes & Noble', format: '', price: '', currency: '',
      note: 'Search link — replace with the direct product URL when you have it.',
      url: `https://www.barnesandnoble.com/s/${term}` });
    links.push({ retailer: 'Kobo', format: 'Ebook', price: '', currency: '',
      note: 'Search link — replace with the direct product URL when you have it.',
      url: `https://www.kobo.com/us/en/search?query=${term}` });
  }
  return links;
}

exports.lookupBookMetadata = onCall(async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  const rawIsbn = String((request.data && request.data.isbn) || '').replace(/[^0-9Xx]/g, '');
  const query   = String((request.data && request.data.query) || '').trim().slice(0, 200);
  if (!rawIsbn && !query) {
    throw new HttpsError('invalid-argument', 'Provide an ISBN or a title to search for.');
  }

  const googleUrl = rawIsbn
    ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(rawIsbn)}`
    : `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`;
  const openLibUrl = rawIsbn
    ? `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(rawIsbn)}&format=json&jscmd=data`
    : null;

  const [google, openLib] = await Promise.all([
    fetchJson(googleUrl),
    openLibUrl ? fetchJson(openLibUrl) : Promise.resolve(null)
  ]);

  const vol = google && google.items && google.items[0] && google.items[0].volumeInfo;
  const ol  = openLib && openLib[`ISBN:${rawIsbn}`];
  if (!vol && !ol) {
    return { found: false, message: 'No match found. Fill the form in by hand — nothing has been changed.' };
  }

  const ids = (vol && vol.industryIdentifiers) || [];
  const pick = (type) => {
    const hit = ids.find((i) => i.type === type);
    return hit ? hit.identifier : '';
  };
  const isbn13 = pick('ISBN_13') || (rawIsbn.length === 13 ? rawIsbn : '');
  const isbn10 = pick('ISBN_10') || (rawIsbn.length === 10 ? rawIsbn : '') || isbn13to10(isbn13);

  const book = {
    title:     (vol && vol.title) || (ol && ol.title) || '',
    subtitle:  (vol && vol.subtitle) || '',
    blurb:     (vol && vol.description) || '',
    publisher: (vol && vol.publisher) || (ol && ol.publishers && ol.publishers[0] && ol.publishers[0].name) || '',
    pageCount: (vol && vol.pageCount) || (ol && ol.number_of_pages) || null,
    language:  (vol && vol.language) || '',
    genre:     (vol && vol.categories && vol.categories.join(', ')) || '',
    // Google's date is sometimes just a year or year-month; only a full date
    // is useful to a reader asking when a book comes out.
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test((vol && vol.publishedDate) || '') ? vol.publishedDate : '',
    coverUrl: (vol && vol.imageLinks && (vol.imageLinks.thumbnail || vol.imageLinks.smallThumbnail) || '')
      .replace(/^http:/, 'https:'),
    isbn13, isbn10, asin: isbn10
  };

  return {
    found: true,
    book,
    suggestedBuyLinks: buildRetailerSuggestions({ isbn13, isbn10, asin: isbn10, title: book.title }),
    sources: [vol ? 'Google Books' : null, ol ? 'Open Library' : null].filter(Boolean)
  };
});

// The chatbot's view of the shelf. Only active books, ordered as the owner
// ordered them. Fails soft: on a read error the assistant simply has no
// shelf, rather than the whole conversation erroring out.
async function loadBookCatalog(db) {
  try {
    const snap = await db.collection('books').where('active', '==', true)
      .orderBy('order', 'asc').limit(60).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (e) {
    console.warn('[courseAdvisorChat] loadBookCatalog failed:', e && e.message);
    return [];
  }
}

function buildBookKnowledge(books) {
  if (!books || !books.length) return '';
  const statusLabel = { out_now: 'Out now', preorder: 'Available to pre-order', coming_soon: 'Coming soon' };
  const blocks = books.map((b) => {
    const lines = [];
    const seriesBit = b.series
      ? ` (${b.series}${b.seriesNumber != null ? `, book ${b.seriesNumber}` : ''})`
      : '';
    lines.push(`### ${b.title}${b.subtitle ? `: ${b.subtitle}` : ''}${seriesBit}`);
    lines.push(`Status: ${statusLabel[b.status] || 'Out now'}${b.releaseDate ? ` — ${b.releaseDate}` : ''}`);
    if (b.genre)     lines.push(`Genre: ${b.genre}`);
    if (b.tropes)    lines.push(`Themes and tropes: ${b.tropes}`);
    if (b.pageCount) lines.push(`Length: ${b.pageCount} pages`);
    if (b.publisher) lines.push(`Publisher: ${b.publisher}`);
    if (b.isbn13)    lines.push(`ISBN-13: ${b.isbn13}`);
    if (b.blurb)     lines.push(`Blurb: ${b.blurb}`);
    if (b.contentNotes)      lines.push(`Content notes: ${b.contentNotes}`);
    if (b.readingOrderNote)  lines.push(`Reading order: ${b.readingOrderNote}`);
    if (b.buyLinks && b.buyLinks.length) {
      lines.push('Where to buy:');
      b.buyLinks.forEach((l) => {
        const bits = [l.format, l.price ? `${l.currency || '$'}${l.price}` : null].filter(Boolean).join(', ');
        lines.push(`- ${l.retailer || 'Retailer'}${bits ? ` (${bits})` : ''}: ${l.url}`);
      });
    }
    if (b.resources && b.resources.length) {
      lines.push('Resources for readers:');
      b.resources.forEach((r) => lines.push(`- ${r.label || 'Resource'}: ${r.url}${r.note ? ` — ${r.note}` : ''}`));
    }
    return lines.join('\n');
  });
  return `\n\nTHE BOOKS (this is the complete, authoritative shelf):\n${blocks.join('\n\n')}\n\nLINK RULE: the URLs above are the ONLY links you may give a reader. Never construct, guess at, or recall from memory a retailer URL, price, or release date for these books. If a reader asks for a format or a retailer that is not listed, say it is not listed and point them to the Inner Circle newsletter or kailey@kaileybrown.com.`;
}

exports.courseAdvisorChat = onCall(async (request) => {
  const db = admin.firestore();
  const { message, history } = request.data || {};

  // Require auth: this endpoint calls a paid LLM on every request, so it must
  // not be open to anonymous callers.
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'message is required.');
  }
  if (message.length > 4000) {
    throw new HttpsError('invalid-argument', 'message is too long (max 4000 chars).');
  }

  // Throttle: at most 20 AI messages per user per 5 minutes.
  await rateLimitCaller(db, request, { action: 'courseAdvisorChat', max: 20, windowSec: 300 });
  // Fetch member context first so we have companyId for community scoping.
  const courseCatalog = await loadCourseCatalog(db);
  const memberContext = uid ? await fetchMemberContext(db, uid, courseCatalog) : null;
  const [knowledgeEntries, communityContext, bookCatalog] = await Promise.all([
    fetchKnowledgeEntries(db),
    uid ? fetchCommunityContext(db, memberContext && memberContext.companyId) : Promise.resolve(null),
    loadBookCatalog(db)
  ]);
  const systemPrompt = buildSystemPrompt(memberContext, knowledgeEntries, communityContext, courseCatalog, bookCatalog);

  // Build conversation history (max 20 turns to stay within context limits).
  const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
  const messages = [
    ...safeHistory.map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.content || '').slice(0, 4000)
    })),
    { role: 'user', content: message.trim() }
  ];

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    throw new HttpsError('internal', 'Anthropic SDK not available.');
  }

  const apiKey = ANTHROPIC_API_KEY();
  if (!apiKey) {
    throw new HttpsError('failed-precondition',
      'ANTHROPIC_API_KEY is not configured. Add it in Firebase Console > Functions > Runtime environment variables.');
  }
  const client = new Anthropic.default({ apiKey });

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: systemPrompt,
    messages
  });

  const rawReply = (response.content && response.content[0] && response.content[0].text) || '';

  // Detect and extract course suggestion signal.
  let replyText = rawReply;
  if (rawReply.includes('COURSE_SUGGESTION_DETECTED')) {
    try {
      const jsonMatch = rawReply.match(/COURSE_SUGGESTION_DETECTED(\{[\s\S]*?\})/);
      if (jsonMatch) {
        const suggestionData = JSON.parse(jsonMatch[1]);
        // Save to Firestore (best-effort — don't fail the reply if this errors).
        try {
          await db.collection('courseSuggestions').add({
            uid: uid || null,
            displayName: (memberContext && memberContext.displayName) || null,
            topic: suggestionData.topic || '',
            goals: suggestionData.goals || '',
            outcomes: suggestionData.outcomes || '',
            rawMessage: message,
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) { console.warn('[courseAdvisorChat] suggestion save failed:', e && e.message); }
      }
    } catch (e) { console.warn('[courseAdvisorChat] suggestion parse failed:', e && e.message); }
    // Strip the internal signal from the user-facing reply.
    replyText = rawReply.replace(/COURSE_SUGGESTION_DETECTED\{[\s\S]*?\}/g, '').trim();
  }

  // Detect and handle profile update signal (authenticated members only).
  let profileUpdated = null;
  if (uid && replyText.includes('PROFILE_UPDATE')) {
    try {
      const match = replyText.match(/PROFILE_UPDATE(\{[\s\S]*?\})/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        const patch = {};
        for (const [key, maxLen] of Object.entries(PROFILE_UPDATE_ALLOWED)) {
          if (parsed[key] === undefined) continue;
          const val = String(parsed[key]).trim().slice(0, maxLen);
          if (val) patch[key] = val;
        }
        if (Object.keys(patch).length) {
          patch.lastActiveAt = admin.firestore.FieldValue.serverTimestamp();
          await db.collection('users').doc(uid).set(patch, { merge: true });
          const { lastActiveAt: _ts, ...updatedFields } = patch;
          profileUpdated = updatedFields;
          console.info('[courseAdvisorChat] profile updated:', uid, Object.keys(updatedFields));
        }
      }
    } catch (e) { console.warn('[courseAdvisorChat] profile update failed:', e && e.message); }
    replyText = replyText.replace(/PROFILE_UPDATE\{[\s\S]*?\}/g, '').trim();
  }

  return { reply: replyText, profileUpdated: profileUpdated || null };
});

// reportBug — any user (authenticated or not) can submit a bug report.
// Captures description + optional screenshot, runs Claude AI analysis,
// saves to bugReports collection, and emails the owner.
exports.reportBug = onCall(async (request) => {
  const db = admin.firestore();

  const { description, screenshotDataUrl, url: pageUrl, userAgent } = request.data || {};
  if (!description || typeof description !== 'string' || !description.trim()) {
    throw new HttpsError('invalid-argument', 'description is required.');
  }
  if (description.length > 2000) {
    throw new HttpsError('invalid-argument', 'description is too long (max 2000 chars).');
  }

  // Open to anonymous users (bug reports from logged-out visitors are useful),
  // but throttled by uid/IP since it runs Claude analysis + emails the owner.
  await rateLimitCaller(db, request, { action: 'reportBug', max: 5, windowSec: 600 });

  const uid = request.auth && request.auth.uid;
  const reportRef = db.collection('bugReports').doc();
  const reportId = reportRef.id;

  // ── Upload screenshot to Firebase Storage ──────────────────────────────────
  let screenshotUrl = null;
  if (screenshotDataUrl && typeof screenshotDataUrl === 'string'
      && screenshotDataUrl.startsWith('data:image/')) {
    try {
      const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      const bucket = admin.storage().bucket();
      const file = bucket.file(`bug-screenshots/${reportId}.jpg`);
      await file.save(buf, { metadata: { contentType: 'image/jpeg' } });
      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000
      });
      screenshotUrl = signedUrl;
    } catch (e) {
      console.warn('[reportBug] screenshot upload failed:', e && e.message);
    }
  }

  // ── Claude AI bug analysis ─────────────────────────────────────────────────
  let aiAnalysis = 'AI analysis unavailable.';
  let aiSeverity = 'unknown';
  try {
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch (e) { throw new Error('Anthropic SDK not available'); }

    const apiKey = ANTHROPIC_API_KEY();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const client = new Anthropic.default({ apiKey });

    const userContent = [];

    if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image/')) {
      const base64Only = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64Only }
      });
    }

    userContent.push({
      type: 'text',
      text: [
        'Bug Report — Kailey Brown Academy web app:',
        '',
        `Description: ${description.trim()}`,
        `Page URL: ${pageUrl || 'unknown'}`,
        `User Agent: ${userAgent || 'unknown'}`,
        `Reported by UID: ${uid || 'anonymous'}`,
        '',
        'Please analyze this bug and respond with:',
        '1. **Root Cause**: What is likely causing this?',
        '2. **Proposed Fix**: Specific code or config change to fix it',
        '3. **Severity**: one of: low | medium | high | critical',
        '',
        'Be concise and specific. The app uses Firebase (Firestore, Auth, Functions, Storage), vanilla JS ES modules, and Firebase Hosting.'
      ].join('\n')
    });

    const aiRes = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: 'You are a senior software engineer reviewing bug reports for a web app called "Kailey Brown Academy". Provide concise, actionable analysis.',
      messages: [{ role: 'user', content: userContent }]
    });

    const rawText = (aiRes.content && aiRes.content[0] && aiRes.content[0].text) || '';
    aiAnalysis = rawText;

    const sevMatch = rawText.match(/\b(critical|high|medium|low)\b/i);
    if (sevMatch) aiSeverity = sevMatch[1].toLowerCase();

  } catch (e) {
    console.warn('[reportBug] AI analysis failed:', e && e.message);
  }

  // ── Save to Firestore ──────────────────────────────────────────────────────
  await reportRef.set({
    reportId,
    description: description.trim().slice(0, 2000),
    pageUrl: (pageUrl || '').slice(0, 500),
    userAgent: (userAgent || '').slice(0, 500),
    reportedByUid: uid || null,
    screenshotUrl,
    aiAnalysis,
    aiSeverity,
    status: 'open',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // ── Email owner ────────────────────────────────────────────────────────────
  try {
    const sgKey = sendgridKey.value();
    sgMail.setApiKey(sgKey);
    const shortDesc = description.trim().slice(0, 80);
    const htmlBody = [
      `<h2 style="color:#C8102E;">Bug Report — ${textToHtml(shortDesc)}</h2>`,
      `<table style="border-collapse:collapse;font-size:13px;">`,
      `<tr><td style="padding:4px 12px 4px 0;color:#888;">Severity</td><td><strong>${aiSeverity}</strong></td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#888;">Page</td><td>${textToHtml(pageUrl || 'unknown')}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;color:#888;">Reporter</td><td>${uid || 'anonymous'}</td></tr>`,
      `</table>`,
      `<h3>Description</h3>`,
      `<blockquote style="border-left:3px solid #C8102E;margin:0;padding:8px 14px;background:#fff8f8;">${textToHtml(description.trim())}</blockquote>`,
      `<h3>AI Analysis &amp; Fix Proposal</h3>`,
      `<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;background:#f5f5f5;padding:12px;border-radius:6px;line-height:1.5;">${textToHtml(aiAnalysis)}</pre>`,
      screenshotUrl
        ? `<p><a href="${screenshotUrl}" style="color:#C8102E;">View Screenshot →</a> (link expires in 30 days)</p>`
        : '<p><em>No screenshot attached.</em></p>',
      `<hr/><p><a href="https://kaileybrown-48e22.web.app/bug-reports.html" style="color:#C8102E;">Review all bug reports →</a></p>`
    ].join('');

    await sgMail.send({
      to: OWNER_EMAIL,
      from: { email: FROM_EMAIL, name: FROM_NAME_DEFAULT },
      replyTo: REPLY_TO,
      subject: `[Bug][${aiSeverity.toUpperCase()}] ${shortDesc}`,
      text: `Bug Report\n\nSeverity: ${aiSeverity}\nPage: ${pageUrl || 'unknown'}\nReporter: ${uid || 'anonymous'}\n\nDescription:\n${description.trim()}\n\nAI Analysis:\n${aiAnalysis}\n\nReview: https://kaileybrown-48e22.web.app/bug-reports.html`,
      html: htmlBody
    });
  } catch (e) {
    console.warn('[reportBug] email send failed:', e && e.message);
  }

  return { ok: true, reportId };
});

// ════════════════════════════════════════════════════════════════
// AI Course Generator — powered by Claude (Anthropic).
//
// Two admin-only callables orchestrated by the course builder
// (public/js/course-ai.js): generateCourseOutline returns the course
// skeleton fast, then the browser calls generateCourseLesson once per
// lesson and writes each result to courses/{slug}/modules/* itself as a
// draft — Firestore writes stay client-side so the security model lives
// in firestore.rules, and a cancelled run simply keeps the drafts
// written so far.
// ════════════════════════════════════════════════════════════════

function getAnthropicClient() {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    throw new HttpsError('internal', 'Anthropic SDK not available.');
  }
  const apiKey = ANTHROPIC_API_KEY();
  if (!apiKey) {
    throw new HttpsError('failed-precondition',
      'ANTHROPIC_API_KEY is not configured. Add it in Firebase Console > Functions > Runtime environment variables.');
  }
  return new Anthropic.default({ apiKey });
}

// Claude is told to answer with ONLY JSON, but be tolerant of markdown
// fences and stray prose around the object.
function extractJson(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new HttpsError('internal', 'AI returned malformed JSON — please try again.');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new HttpsError('internal', 'AI returned malformed JSON — please try again.');
  }
}

const clampStr = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

exports.generateCourseOutline = onCall({ timeoutSeconds: 300 }, async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  await rateLimitCaller(db, request, { action: 'generateCourse', max: 30, windowSec: 3600 });

  const topic = clampStr(request.data && request.data.topic, 2000);
  if (!topic) throw new HttpsError('invalid-argument', 'topic is required.');
  const audience = clampStr(request.data && request.data.audience, 500);
  const notes = clampStr(request.data && request.data.notes, 2000);
  const source = clampStr(request.data && request.data.source, 80000);
  let lessonCount = parseInt(request.data && request.data.lessonCount, 10);
  if (!Number.isFinite(lessonCount)) lessonCount = 5;
  lessonCount = Math.max(1, Math.min(12, lessonCount));

  const system = [
    'You design online courses for Kailey Brown Academy, a personal-growth and',
    'leadership platform focused on mindset, discipline, and self-mastery.',
    'You respond with ONLY a valid JSON object — no prose, no markdown fences.',
    'Schema:',
    '{',
    '  "title": "course title (max 70 chars)",',
    '  "short": "very short display name (max 20 chars)",',
    '  "subtitle": "one-line tagline",',
    '  "category": "e.g. Mindset & Personal Growth",',
    '  "description": ["2-4 sales-page paragraphs"],',
    '  "whatYoullLearn": ["4-6 concrete outcomes"],',
    '  "lessons": [',
    '    { "title": "lesson title", "subtitle": "one line",',
    '      "pillar": "section label like \'Part 1 — Foundations\'",',
    '      "duration": "estimate like \'15 min\'", "tagLabel": "LESSON",',
    '      "brief": "2-3 sentences specifying exactly what this lesson must cover" }',
    '  ]',
    '}',
    `The lessons array must contain exactly ${lessonCount} lessons that build on`,
    'each other in a logical arc. Group lessons into 2-3 pillars when it helps.',
    'When the creator provides reference material, base the course structure and',
    'lesson briefs on it — use its concepts, terminology, and examples.'
  ].join('\n');

  const user = [
    `Course topic / description: ${topic}`,
    audience ? `Target audience: ${audience}` : '',
    notes ? `Additional notes from the course creator: ${notes}` : '',
    source ? `Reference material from the course creator (manuscripts/notes to base the course on):\n"""\n${source}\n"""` : ''
  ].filter(Boolean).join('\n');

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: user }]
  });

  const outline = extractJson(
    (response.content && response.content[0] && response.content[0].text) || '');
  if (!Array.isArray(outline.lessons) || !outline.lessons.length) {
    throw new HttpsError('internal', 'AI outline had no lessons — please try again.');
  }
  return { outline };
});

exports.generateCourseLesson = onCall({ timeoutSeconds: 300 }, async (request) => {
  const db = admin.firestore();
  if (!(await isAdminCaller(db, request))) {
    throw new HttpsError('permission-denied', 'Admin or owner role required.');
  }
  await rateLimitCaller(db, request, { action: 'generateCourseLesson', max: 60, windowSec: 3600 });

  const d = request.data || {};
  const lessonTitle = clampStr(d.lessonTitle, 200);
  if (!lessonTitle) throw new HttpsError('invalid-argument', 'lessonTitle is required.');
  const courseTitle = clampStr(d.courseTitle, 200);
  const audience = clampStr(d.audience, 500);
  const lessonSubtitle = clampStr(d.lessonSubtitle, 300);
  const brief = clampStr(d.brief, 2000);
  const lessonNumber = parseInt(d.lessonNumber, 10) || 1;
  const totalLessons = parseInt(d.totalLessons, 10) || 1;
  const outlineTitles = (Array.isArray(d.outlineTitles) ? d.outlineTitles : [])
    .slice(0, 12).map((t) => clampStr(t, 200));
  const source = clampStr(d.source, 80000);

  const system = [
    'You write full lessons for online courses on Kailey Brown Academy, a',
    'personal-growth and leadership platform. Write with energy and directness;',
    'be practical and specific, never generic filler.',
    'You respond with ONLY a valid JSON object — no prose, no markdown fences.',
    'Schema:',
    '{',
    '  "html": "the complete lesson body as HTML",',
    '  "workbook": { "reflection": "one reflection prompt", "action": "one action prompt",',
    '                "prompts": ["2-4 writing prompts"] } or null,',
    '  "summary": ["3-5 key takeaways"] or null',
    '}',
    'The html field: 600-1000 words using ONLY these tags: <h2>, <h3>, <p>,',
    '<ul>, <ol>, <li>, <blockquote>, <strong>, <em>. No images, iframes,',
    'scripts, styles, or classes. Escape the HTML properly inside the JSON string.',
    'When the creator provides reference material, ground the lesson in it —',
    'draw on its concepts, terminology, stories, and examples rather than inventing your own.'
  ].join('\n');

  const user = [
    courseTitle ? `Course: ${courseTitle}` : '',
    audience ? `Audience: ${audience}` : '',
    outlineTitles.length ? `Full course outline:\n${outlineTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
    `Write lesson ${lessonNumber} of ${totalLessons}: "${lessonTitle}"`,
    lessonSubtitle ? `Lesson subtitle: ${lessonSubtitle}` : '',
    brief ? `This lesson must cover: ${brief}` : '',
    source ? `Reference material from the course creator (base the lesson on this):\n"""\n${source}\n"""` : ''
  ].filter(Boolean).join('\n');

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 6000,
    system,
    messages: [{ role: 'user', content: user }]
  });

  const lesson = extractJson(
    (response.content && response.content[0] && response.content[0].text) || '');
  if (!lesson.html || typeof lesson.html !== 'string') {
    throw new HttpsError('internal', 'AI lesson had no content — please try again.');
  }
  return { lesson };
});
