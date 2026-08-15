// Coupons manager — lifted from manage-courses.js so the course builder
// module stays focused. Same Firestore contract: coupons/{CODE} docs synced
// to Stripe via the `syncCoupon` callable.

import { db, functions } from './firebase.js';
import {
  doc, getDoc, getDocs, setDoc, collection, serverTimestamp
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

function ok(el, msg) { el.innerHTML = `<div class="auth-ok">${msg}</div>`; }
function err(el, e) { el.innerHTML = `<div class="auth-error">${escapeHtml(e && e.message ? e.message : String(e))}</div>`; }

let _userEmail = null;

export async function refreshCoupons() {
  const body = $('coupons-body');
  try {
    const snap = await getDocs(collection(db, 'coupons'));
    if (snap.empty) {
      body.innerHTML = `<tr><td colspan="6" style="color:var(--gray-mid);">No coupons yet.</td></tr>`;
      return;
    }
    body.innerHTML = snap.docs.map((d) => {
      const c = d.data();
      const discount = c.percentOff ? `${c.percentOff}% off` : (c.amountOff ? `$${c.amountOff} off` : '—');
      const expires = c.expiresAt && c.expiresAt.toDate ? c.expiresAt.toDate().toLocaleDateString() : '—';
      return `<tr>
        <td><b>${escapeHtml(d.id)}</b></td>
        <td>${escapeHtml(discount)}</td>
        <td>${escapeHtml(expires)}</td>
        <td>${c.active ? '<span class="auth-ok" style="font-size:12px;">Active</span>' : '<span style="color:var(--red); font-size:12px;">Disabled</span>'}</td>
        <td>${c.stripePromotionCodeId ? 'Synced ✓' : `<button class="btn btn-ghost" data-sync="${escapeHtml(d.id)}" style="padding:2px 8px; font-size:11px;">Sync to Stripe</button>`}</td>
        <td><button class="btn btn-ghost" data-toggle-coupon="${escapeHtml(d.id)}" style="padding:2px 8px; font-size:11px;">${c.active ? 'Disable' : 'Enable'}</button></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-toggle-coupon]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ref = doc(db, 'coupons', b.dataset.toggleCoupon);
        const snap2 = await getDoc(ref);
        if (!snap2.exists()) return;
        await setDoc(ref, { active: !snap2.data().active }, { merge: true });
        await refreshCoupons();
      }));
    body.querySelectorAll('[data-sync]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Syncing…';
        try {
          await httpsCallable(functions, 'syncCoupon')({ code: b.dataset.sync });
          await refreshCoupons();
        } catch (e) {
          alert(e.message || 'Sync failed. Is Stripe configured?');
          b.disabled = false;
          b.textContent = 'Sync to Stripe';
        }
      }));
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="color:var(--red);">${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function createCoupon(e) {
  e.preventDefault();
  const out = $('coupon-result');
  try {
    const code = $('cp-code').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) throw new Error('Code is required.');
    const percentOff = $('cp-percent').value ? Number($('cp-percent').value) : null;
    const amountOff = $('cp-amount').value ? Number($('cp-amount').value) : null;
    if (!percentOff && !amountOff) throw new Error('Set either a % off or a $ off amount.');
    if (percentOff && amountOff) throw new Error('Use % off OR $ off, not both.');
    const expiresRaw = $('cp-expires').value;
    await setDoc(doc(db, 'coupons', code), {
      code,
      percentOff,
      amountOff,
      active: true,
      expiresAt: expiresRaw ? new Date(expiresRaw + 'T23:59:59') : null,
      createdAt: serverTimestamp(),
      createdBy: _userEmail
    });
    ok(out, `Coupon <b>${escapeHtml(code)}</b> created. Click "Sync to Stripe" to make it redeemable at checkout.`);
    $('coupon-form').reset();
    await refreshCoupons();
  } catch (e2) { err(out, e2); }
}

export function initCoupons({ userEmail } = {}) {
  _userEmail = userEmail || null;
  const form = $('coupon-form');
  if (form) form.addEventListener('submit', createCoupon);
  refreshCoupons();
}
