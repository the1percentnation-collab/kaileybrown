// Admin console: company roster, invites, seats.
// Only visible to admins of a company (or owners, who can manage any).

import { db, firebaseReady, functions } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderTopbar } from './topbar.js';
import {
  collection, doc, getDoc, getDocs, query, where, setDoc, deleteDoc, serverTimestamp, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const $ = (id) => document.getElementById(id);

function gate(msg) {
  $('gate-msg').innerHTML = `<div class="card"><div class="auth-error">${msg}</div></div>`;
}

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function fmtTs(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return '—'; }
}

let _state = {
  companyId: null,
  company: null,
  role: null
};

async function loadCompany() {
  const { companyId, company } = _state;
  $('company-name').textContent = company.name || `Company (${companyId})`;
  $('company-meta').textContent = `ID: ${companyId} · Tier: ${company.tier || '—'}`;
  const used = company.seatsUsed || 0;
  const total = company.seatCount || 0;
  $('seat-stats').innerHTML = `
    <div><span style="color:var(--gray-light);">Seats used:</span> <span style="color:var(--white);">${used}/${total}</span></div>
    <div><span style="color:var(--gray-light);">Admins:</span> <span style="color:var(--white);">${(company.adminUids || []).length}</span></div>
  `;
}

async function loadRoster() {
  const body = $('roster-body');
  body.innerHTML = '';
  const { companyId } = _state;
  let snap;
  try {
    // Members subcollection is mirrored by the acceptInvite Cloud Function. Admins can
    // read it under the rules without needing list access on the top-level users collection.
    snap = await getDocs(collection(db, 'companies', companyId, 'members'));
  } catch (e) {
    $('roster-msg').textContent = 'Could not load roster: ' + (e.message || e);
    return;
  }

  const rows = [];
  for (const d of snap.docs) {
    const u = d.data();
    const uid = d.id;
    // Admins CAN'T read users/{uid}/progress or /capstone (rules deny it by design so notes
    // stay private). The member doc carries an aggregate digest written by the user's own
    // client: completedCount, currentModule, lastActiveAt, capstoneStatus.
    rows.push({
      uid,
      displayName: u.displayName || '—',
      email: u.email || '—',
      completedCount: typeof u.completedCount === 'number' ? u.completedCount : 0,
      lastActiveAt: u.lastActiveAt,
      capstoneStatus: u.capstoneStatus || '—',
      role: 'user'
    });
  }

  // Total modules — known to frontend but we don't import modules.js here; use 8 buckets max.
  const TOTAL = 8;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" style="color:var(--gray-mid);">No employees yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const cc = typeof r.completedCount === 'number' ? r.completedCount : 0;
    const pct = Math.min(100, Math.round((cc / TOTAL) * 100));
    return `<tr>
      <td>${r.displayName}</td>
      <td>${r.email}</td>
      <td>
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="flex:1; max-width:120px; height:4px; background:var(--border); border-radius:2px; overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:var(--red);"></div>
          </div>
          <span class="num" style="color:var(--white); font-family:var(--font-mono); font-size:11px;">${pct}%</span>
        </div>
      </td>
      <td class="num">${cc}</td>
      <td>${fmtTs(r.lastActiveAt)}</td>
      <td><span class="pill ${r.capstoneStatus === '—' ? 'pill-muted' : 'pill-warn'}">${r.capstoneStatus}</span></td>
      <td style="display:flex; gap:6px; white-space:nowrap;">
        <button class="btn btn-ghost" data-revoke="${r.uid}" title="Remove from this company — keeps user account + personal progress.">Remove from company</button>
        <button class="btn btn-ghost roster-delete" data-delete="${r.uid}" data-email="${escapeHtml(r.email)}" title="Permanently delete this user — wipes account, progress, enrollments.">Delete user</button>
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-revoke]').forEach((b) => {
    b.addEventListener('click', () => revokeSeat(b.dataset.revoke));
  });
  body.querySelectorAll('[data-delete]').forEach((b) => {
    b.addEventListener('click', () => deleteUser(b.dataset.delete, b.dataset.email));
  });
}

async function deleteUser(uid, email) {
  const confirmMsg = `Permanently delete ${email || uid}?\n\n` +
    `This wipes:\n` +
    `  • Their Firebase Auth account (they cannot sign back in)\n` +
    `  • Their user doc + all progress, capstone, and enrollments\n` +
    `  • Their entry in this company's roster and any admin role\n\n` +
    `This cannot be undone.`;
  if (!confirm(confirmMsg)) return;

  try {
    const call = httpsCallable(functions, 'deleteUser');
    const res = await call({ uid });
    const deleted = (res && res.data && res.data.deleted) || 0;
    alert(`User deleted. ${deleted} Firestore doc(s) removed.`);
    // Refresh — seat count + roster should reflect the change.
    const snap = await getDoc(doc(db, 'companies', _state.companyId));
    if (snap.exists()) _state.company = snap.data();
    await loadCompany();
    await loadRoster();
  } catch (e) {
    alert('Could not delete user: ' + (e.message || e));
  }
}

async function revokeSeat(uid) {
  if (!confirm('Remove this employee from the company? Their personal progress is preserved.')) return;
  const { companyId, company } = _state;
  try {
    // Remove the member roster doc. Note: we cannot clear the user's companyId on users/{uid}
    // from an admin account (rules only allow self/owner writes on that doc). The canonical
    // effect of revocation is: they lose their company-scoped membership view. They keep
    // personal progress. Owner can fully reset companyId if needed.
    await deleteDoc(doc(db, 'companies', companyId, 'members', uid));
    const newUsed = Math.max(0, (company.seatsUsed || 0) - 1);
    await setDoc(doc(db, 'companies', companyId), {
      seatsUsed: newUsed
    }, { merge: true });
    _state.company.seatsUsed = newUsed;
    await loadCompany();
    await loadRoster();
  } catch (e) {
    alert('Could not revoke: ' + (e.message || e));
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function emailStatusHtml(i) {
  // i.emailStatus may be: 'sent', 'failed', 'skipped', or undefined (pending).
  const status = i.emailStatus;
  if (status === 'sent') {
    return `<span class="invite-email-status sent">✓ Sent</span>`;
  }
  if (status === 'failed') {
    const err = i.emailError ? ` — ${escapeHtml(String(i.emailError).slice(0, 80))}` : '';
    return `<span class="invite-email-status failed" title="${escapeHtml(i.emailError || '')}">✗ Failed${err}</span>`;
  }
  if (status === 'skipped') {
    return `<span class="invite-email-status pending">(no email)</span>`;
  }
  return `<span class="invite-email-status pending">Pending</span>`;
}

async function loadInvites() {
  const body = $('invites-body');
  body.innerHTML = '';
  const { companyId } = _state;
  try {
    const snap = await getDocs(collection(db, 'companies', companyId, 'invites'));
    if (snap.empty) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--gray-mid);">No invites yet.</td></tr>`;
      return;
    }
    body.innerHTML = snap.docs.map((d) => {
      const i = d.data();
      const link = `${location.origin}/invite.html?code=${encodeURIComponent(i.code)}`;
      const statusPill = i.status === 'accepted' ? 'pill-ok' : (i.status === 'revoked' ? 'pill-red' : 'pill-warn');
      const showEmail = i.status === 'pending' || !i.status;
      return `<tr>
        <td>${escapeHtml(i.email || '—')}</td>
        <td class="num">${escapeHtml(i.code)}</td>
        <td>
          <span class="pill ${statusPill}">${escapeHtml(i.status || 'pending')}</span>
          ${showEmail ? `<div style="margin-top:4px;">${emailStatusHtml(i)}</div>` : ''}
        </td>
        <td><a href="${link}" target="_blank" style="color:var(--accent); font-family:var(--font-mono); font-size:11px;">${escapeHtml(link)}</a></td>
      </tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" style="color:var(--red);">Load error: ${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function createInvite(email) {
  const { companyId, company } = _state;
  if ((company.seatsUsed || 0) >= (company.seatCount || 0)) {
    throw new Error('No seats remaining — increase seat count first.');
  }
  const code = randCode();
  const id = code; // use the code as the doc id so lookups by code are O(1)
  await setDoc(doc(db, 'companies', companyId, 'invites', id), {
    email: email || null,
    code,
    status: 'pending',
    companyId,
    createdAt: serverTimestamp(),
    acceptedByUid: null
  });
  return code;
}

async function main() {
  if (!firebaseReady) { gate('Firebase is unavailable.'); return; }
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/admin.html')); return; }

  const info = await getRoleInfo(true);
  _state.role = info.role;
  renderTopbar({ user: u, role: info.role, currentPage: 'admin' });

  // Owner path: find or let them pick a company via ?companyId=
  let companyId = new URLSearchParams(location.search).get('companyId') || info.companyId;

  // If admin has no companyId but there's a company where their uid is in adminUids, try that.
  if (!companyId && info.isAdmin) {
    try {
      const q = query(collection(db, 'companies'), where('adminUids', 'array-contains', u.uid), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) companyId = snap.docs[0].id;
    } catch (e) {}
  }

  if (!companyId) {
    gate('You are not an admin of any company yet. Ask the owner to create your company or visit /owner.html if you are the owner.');
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'companies', companyId));
    if (!snap.exists()) { gate('Company not found: ' + companyId); return; }
    _state.companyId = companyId;
    _state.company = snap.data();
  } catch (e) {
    gate('Could not load company: ' + (e.message || e));
    return;
  }

  // Gate: must be owner or in adminUids.
  const adminUids = _state.company.adminUids || [];
  if (info.role !== 'owner' && !adminUids.includes(u.uid)) {
    gate('You do not have admin access to this company.');
    return;
  }

  $('panel').style.display = 'block';
  await loadCompany();
  await loadRoster();
  await loadInvites();

  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('invite-email').value.trim();
    try {
      const code = await createInvite(email);
      const link = `${location.origin}/invite.html?code=${encodeURIComponent(code)}`;
      $('invite-result').innerHTML = `
        <div class="auth-ok">Invite created for ${email || 'anyone'}.</div>
        <div class="invite-code">${link}</div>
        <button class="btn btn-ghost" id="btn-copy">Copy link</button>
      `;
      $('btn-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(link); $('btn-copy').textContent = 'Copied!'; } catch (err) {}
      });
      $('invite-email').value = '';
      await loadInvites();
    } catch (err) {
      $('invite-result').innerHTML = `<div class="auth-error">${err.message || err}</div>`;
    }
  });
}

main();
