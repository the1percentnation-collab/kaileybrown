// Affiliate dashboard — for salespeople. Looks up the affiliate record
// matching the signed-in account's email (set by the owner/admin in
// /manage-affiliates.html) and shows their link, stats, and commissions.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderTopbar } from './topbar.js';
import {
  collection, query, where, getDocs, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function gate(msg) {
  $('gate-msg').innerHTML = `<div class="card"><div class="auth-error">${msg}</div></div>`;
}

function money(n) {
  const v = typeof n === 'number' ? n : 0;
  return '$' + v.toFixed(2);
}

async function main() {
  if (!firebaseReady) { gate('Firebase is unavailable.'); return; }
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/affiliate.html')); return; }

  try {
    const info = await getRoleInfo();
    renderTopbar({ user: u, role: info.role, currentPage: null });
  } catch (e) {}

  // Find this user's affiliate record by account email.
  let aff = null;
  try {
    const q = query(collection(db, 'affiliates'), where('email', '==', (u.email || '').toLowerCase()), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) aff = { code: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (e) {
    console.warn('[affiliate] lookup failed', e);
  }

  if (!aff) {
    gate(`No affiliate account is linked to <b>${escapeHtml(u.email || '')}</b>. If you were invited to the affiliate program, make sure you signed in with the same email — or contact the program owner.`);
    return;
  }
  if (aff.active === false) {
    gate('Your affiliate account is currently disabled. Contact the program owner.');
    return;
  }

  $('panel').style.display = 'block';
  $('aff-hello').textContent = `Welcome, ${aff.name || u.email}`;
  $('aff-pct').textContent = `${aff.commissionPercent != null ? aff.commissionPercent : 20}%`;

  const link = `${location.origin}/courses.html?ref=${encodeURIComponent(aff.code)}`;
  $('aff-link').value = link;
  $('btn-copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('btn-copy-link').textContent = 'Copied ✓';
      setTimeout(() => { $('btn-copy-link').textContent = 'Copy'; }, 1500);
    } catch (e) { prompt('Copy this link:', link); }
  });

  const pending = Math.max(0, (aff.totalCommission || 0) - (aff.totalPaid || 0));
  $('stats-body').innerHTML = `<tr>
    <td class="num">${aff.clicks || 0}</td>
    <td class="num">${aff.saleCount || 0}</td>
    <td class="num">${money(aff.totalSales)}</td>
    <td class="num">${money(aff.totalCommission)}</td>
    <td class="num">${money(aff.totalPaid)}</td>
    <td class="num"><b>${money(pending)}</b></td>
  </tr>`;

  const salesBody = $('sales-body');
  try {
    const snap = await getDocs(collection(db, 'affiliates', aff.code, 'referrals'));
    if (snap.empty) {
      salesBody.innerHTML = `<tr><td colspan="5" style="color:var(--gray-mid);">No sales yet — share your link to get started.</td></tr>`;
      return;
    }
    const rows = snap.docs
      .map((d) => d.data())
      .sort((a, b) => {
        const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return tb - ta;
      });
    salesBody.innerHTML = rows.map((r) => `<tr>
      <td>${r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleDateString() : '—'}</td>
      <td>${escapeHtml(r.courseSlug || '—')}</td>
      <td class="num">${money(r.saleAmount)}</td>
      <td class="num"><b>${money(r.commission)}</b></td>
      <td>${r.status === 'paid' ? '<span class="auth-ok" style="font-size:12px;">Paid</span>' : '<span style="color:var(--gray-light); font-size:12px;">Pending</span>'}</td>
    </tr>`).join('');
  } catch (e) {
    salesBody.innerHTML = `<tr><td colspan="5" style="color:var(--red);">${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

main();
