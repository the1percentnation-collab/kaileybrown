// Roles — reads the current user's role from both custom claims and Firestore users/{uid}.
// Custom claim wins (owner is set via `bootstrapOwner` Cloud Function). Firestore doc is
// authoritative for admin/user role and companyId.
//
// The last successfully resolved role is also mirrored into localStorage, per uid. Two
// reasons:
//   1. Pages can paint the topbar (and its Admin/Owner menu) immediately on load instead
//      of waiting a Firestore round-trip — see `cachedRoleInfo()`.
//   2. If the users/{uid} read fails (offline, blocked request, rules hiccup), we keep the
//      last known role instead of silently demoting an admin to 'user' and hiding every
//      privileged link on the page.

import { auth, db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _cache = null; // { uid, info }

const LS_ROLE_PREFIX = 'role:';

function lsKey(uid) { return `${LS_ROLE_PREFIX}${uid}`; }

function readPersisted(uid) {
  try {
    const raw = localStorage.getItem(lsKey(uid));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.role !== 'string') return null;
    return { role: p.role, companyId: p.companyId || null };
  } catch (e) { return null; }
}

function writePersisted(uid, role, companyId) {
  try { localStorage.setItem(lsKey(uid), JSON.stringify({ role, companyId: companyId || null })); }
  catch (e) { /* private mode / quota — cache is a nicety, not a requirement */ }
}

function dropPersisted(uid) {
  try { localStorage.removeItem(lsKey(uid)); } catch (e) {}
}

function shape(user, role, companyId) {
  return {
    user,
    role,
    companyId: companyId || null,
    isOwner: role === 'owner',
    isAdmin: role === 'admin' || role === 'owner'
  };
}

/**
 * Last known role for the signed-in user, read synchronously from localStorage.
 * Returns null when there is no signed-in user or nothing cached yet.
 *
 * Callers use this to render role-aware chrome on first paint; the authoritative
 * `getRoleInfo()` result should still be applied when it arrives. It only ever
 * reflects a role this browser previously resolved for this uid, and every
 * privileged action is enforced server-side by Firestore rules / callables, so a
 * stale value grants nothing — at worst it shows a link that then gates.
 */
export function cachedRoleInfo() {
  const user = auth && auth.currentUser;
  if (!user) return null;
  const p = readPersisted(user.uid);
  return p ? shape(user, p.role, p.companyId) : null;
}

export async function getRoleInfo(forceRefresh = false) {
  const user = auth && auth.currentUser;
  if (!user) {
    _cache = null;
    return shape(null, null, null);
  }
  if (!forceRefresh && _cache && _cache.uid === user.uid) return _cache.info;

  let claimsRole = null;
  try {
    const tok = await user.getIdTokenResult(forceRefresh);
    claimsRole = tok.claims && tok.claims.role ? tok.claims.role : null;
  } catch (e) {}

  let docRole = null;
  let companyId = null;
  let docRead = false;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    docRead = true;
    if (snap.exists()) {
      const data = snap.data();
      docRole = data.role || null;
      companyId = data.companyId || null;
    }
  } catch (e) {
    console.warn('[roles] users doc read failed, using last known role:', e);
  }

  // If the read never landed, fall back to whatever this browser last resolved
  // rather than defaulting to 'user' — a transient failure should not strip an
  // admin of every privileged link on the page.
  const persisted = docRead ? null : readPersisted(user.uid);

  // Owner claim beats everything. Otherwise Firestore role, then last known, then 'user'.
  const role = claimsRole === 'owner'
    ? 'owner'
    : (docRole || (persisted && persisted.role) || 'user');
  const resolvedCompanyId = companyId || (persisted && persisted.companyId) || null;

  const info = shape(user, role, resolvedCompanyId);
  _cache = { uid: user.uid, info };
  if (docRead || claimsRole === 'owner') writePersisted(user.uid, role, resolvedCompanyId);
  return info;
}

export function clearRoleCache() {
  const uid = _cache && _cache.uid;
  _cache = null;
  if (uid) dropPersisted(uid);
}
