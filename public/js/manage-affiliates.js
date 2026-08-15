// Affiliate management console — owner + company admins.
// Create salespeople with referral codes + commission rates, watch clicks /
// sales / earnings, and mark accrued commissions as paid after sending the
// actual payout (bank transfer, PayPal, etc. — handled outside the platform).

import { db, functions, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderTopbar } from './topbar.js';
import {
  collection, doc, getDoc, getDocs, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

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

function codeFromName(name) {
  const base = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'AFF';
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[^A-Z0-9]/g, '0');
  return base + rand;
}

let _userEmail = null;

async function refreshAffiliates() {
  const body = $('affiliates-body');
  try {
    const snap = await getDocs(collection(db, 'affiliates'));
    if (snap.empty) {
      body.innerHTML = `<tr><td colspan="9" style="color:var(--gray-mid);">No affiliates yet.</td></tr>`;
      return;
    }
    body.innerHTML = snap.docs.map((d) => {
      const a = d.data();
      const unpaid = Math.max(0, (a.totalCommission || 0) - (a.totalPaid || 0));
      const link = `${location.origin}/courses.html?ref=${encodeURIComponent(d.id)}`;
      return `<tr>
        <td><b>${escapeHtml(a.name || '—')}</b><br><span style="font-size:11px; color:var(--gray-mid);">${escapeHtml(a.email || '')}</span></td>
        <td><code style="font-size:12px;">${escapeHtml(d.id)}</code>
            <button class="btn btn-ghost" data-copy="${escapeHtml(link)}" style="padding:2px 8px; font-size:11px;">Copy link</button></td>
        <td class="num">${a.commissionPercent != null ? a.commissionPercent : 20}%</td>
        <td class="num">${a.clicks || 0}</td>
        <td class="num">${a.saleCount || 0} · ${money(a.totalSales)}</td>
        <td class="num">${money(a.totalCommission)}</td>
        <td class="num"><b>${money(unpaid)}</b></td>
        <td>${a.active !== false ? '<span class="auth-ok" style="font-size:12px;">Active</span>' : '<span style="color:var(--red); font-size:12px;">Disabled</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost" data-sales="${escapeHtml(d.id)}" style="padding:2px 8px; font-size:11px;">Sales</button>
          <button class="btn btn-ghost" data-pay="${escapeHtml(d.id)}" style="padding:2px 8px; font-size:11px;" ${unpaid > 0 ? '' : 'disabled'}>Mark paid</button>
          <button class="btn btn-ghost" data-toggle="${escapeHtml(d.id)}" style="padding:2px 8px; font-size:11px;">${a.active !== false ? 'Disable' : 'Enable'}</button>
        </td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          b.textContent = 'Copied ✓';
          setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
        } catch (e) { prompt('Copy this link:', b.dataset.copy); }
      }));
    body.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ref = doc(db, 'affiliates', b.dataset.toggle);
        const snap2 = await getDoc(ref);
        if (!snap2.exists()) return;
        await setDoc(ref, { active: snap2.data().active === false }, { merge: true });
        await refreshAffiliates();
      }));
    body.querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', async () => {
        const code = b.dataset.pay;
        if (!confirm(`Mark all pending commissions for ${code} as paid?\n\nOnly do this AFTER you've actually sent them the money.`)) return;
        b.disabled = true;
        b.textContent = 'Updating…';
        try {
          const res = await httpsCallable(functions, 'markAffiliatePaid')({ code });
          alert(`Marked ${res.data.paidCount} sale(s) paid — ${money(res.data.paidAmount)}.`);
        } catch (e) {
          alert(e.message || 'Failed to mark paid.');
        }
        await refreshAffiliates();
      }));
    body.querySelectorAll('[data-sales]').forEach((b) =>
      b.addEventListener('click', () => showReferrals(b.dataset.sales)));
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="color:var(--red);">${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function showReferrals(code) {
  $('referrals-card').style.display = 'block';
  $('referrals-title').textContent = `Sales — ${code}`;
  const body = $('referrals-body');
  body.innerHTML = `<tr><td colspan="6" style="color:var(--gray-mid);">Loading…</td></tr>`;
  try {
    const snap = await getDocs(collection(db, 'affiliates', code, 'referrals'));
    if (snap.empty) {
      body.innerHTML = `<tr><td colspan="6" style="color:var(--gray-mid);">No sales yet.</td></tr>`;
      return;
    }
    const rows = snap.docs
      .map((d) => d.data())
      .sort((a, b) => {
        const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return tb - ta;
      });
    body.innerHTML = rows.map((r) => `<tr>
      <td>${r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleDateString() : '—'}</td>
      <td>${escapeHtml(r.courseSlug || '—')}</td>
      <td class="num">${money(r.saleAmount)}</td>
      <td class="num">${r.commissionPercent != null ? r.commissionPercent : '—'}%</td>
      <td class="num"><b>${money(r.commission)}</b></td>
      <td>${r.status === 'paid' ? '<span class="auth-ok" style="font-size:12px;">Paid</span>' : '<span style="color:var(--gray-light); font-size:12px;">Pending</span>'}</td>
    </tr>`).join('');
    $('referrals-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="color:var(--red);">${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function createAffiliate(e) {
  e.preventDefault();
  const out = $('aff-result');
  try {
    const name = $('a-name').value.trim();
    const email = $('a-email').value.trim().toLowerCase();
    const percent = Number($('a-percent').value);
    if (!name || !email) throw new Error('Name and email are required.');
    if (!Number.isFinite(percent) || percent < 1 || percent > 90) {
      throw new Error('Commission must be between 1 and 90 percent.');
    }
    let code = $('a-code').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) code = codeFromName(name);

    const ref = doc(db, 'affiliates', code);
    const existing = await getDoc(ref);
    if (existing.exists()) throw new Error(`Code ${code} is already taken — pick another.`);

    await setDoc(ref, {
      code,
      name,
      email,
      uid: null,
      commissionPercent: percent,
      active: true,
      clicks: 0,
      saleCount: 0,
      totalSales: 0,
      totalCommission: 0,
      totalPaid: 0,
      createdAt: serverTimestamp(),
      createdBy: _userEmail
    });
    const link = `${location.origin}/courses.html?ref=${encodeURIComponent(code)}`;
    out.innerHTML = `<div class="auth-ok">Created <b>${escapeHtml(name)}</b> — referral link: <code>${escapeHtml(link)}</code></div>`;
    $('aff-form').reset();
    $('a-percent').value = 20;
    await refreshAffiliates();
  } catch (e2) {
    out.innerHTML = `<div class="auth-error">${escapeHtml(e2.message || String(e2))}</div>`;
  }
}

async function main() {
  if (!firebaseReady) { gate('Firebase is unavailable.'); return; }
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/manage-affiliates.html')); return; }
  _userEmail = u.email || u.uid;

  const info = await getRoleInfo(true);
  renderTopbar({ user: u, role: info.role, currentPage: null });
  if (!info.isAdmin) {
    gate(`You are signed in as <b>${escapeHtml(u.email || '')}</b> but this page requires an admin or owner account.`);
    return;
  }
  $('panel').style.display = 'block';

  $('aff-form').addEventListener('submit', createAffiliate);
  await refreshAffiliates();
}

main();
