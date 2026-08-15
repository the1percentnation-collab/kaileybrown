// Public "what's coming" page — browse upcoming products, join a product's
// interest list, or join the general early-access list. No login required.

import { firebaseReady } from './firebase.js';
import {
  listVisibleProducts, registerInterest, joinEarlyAccess, escapeHtml, fmtMoney
} from './products.js';

const $ = (id) => document.getElementById(id);

function cardHtml(p) {
  const price = fmtMoney(p.price);
  const badge = p.status === 'live' ? 'Available now' : (p.status === 'preorder' ? 'Pre-order' : 'Coming soon');
  return `
    <div class="card pre-card" data-product="${escapeHtml(p.id)}">
      ${p.imageUrl ? `<img class="pre-card-img" src="${escapeHtml(p.imageUrl)}" alt="">` : ''}
      <div class="pre-card-badge">${escapeHtml(badge)}</div>
      <h3 class="pre-card-title">${escapeHtml(p.name)}</h3>
      ${p.summary ? `<p class="pre-card-sum">${escapeHtml(p.summary)}</p>` : ''}
      <div class="pre-card-foot">
        ${price ? `<span class="pre-card-price">${price}</span>` : '<span class="pre-card-price muted">TBA</span>'}
        ${p.interestCount ? `<span class="pre-card-count">🔥 ${p.interestCount} interested</span>` : ''}
      </div>
      ${p.status === 'live'
        ? `<a class="btn btn-primary" href="/courses.html">View it →</a>`
        : `<button class="btn btn-primary" data-interest="${escapeHtml(p.id)}">Notify me</button>`}
    </div>`;
}

function openInterestModal(product) {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal auth-card">
        <h1>Join the <span>list</span></h1>
        <div class="pre-modal-sub">Be the first to know when <b>${escapeHtml(product.name)}</b> launches.</div>
        <form id="int-form" class="crm-form">
          <div class="crm-form-row"><label>Name</label><input class="c-input" id="i-name" placeholder="Your name" /></div>
          <div class="crm-form-row"><label>Email *</label><input class="c-input" id="i-email" type="email" required placeholder="you@email.com" /></div>
          <div class="crm-form-row"><label>Phone (optional)</label><input class="c-input" id="i-phone" placeholder="+1 555…" /></div>
          <label class="pre-consent"><input type="checkbox" id="i-consent" /> Email/SMS me updates about this</label>
          <div id="i-err" class="auth-error" style="display:none;"></div>
          <div id="i-ok" class="auth-ok" style="display:none;"></div>
          <div class="crm-modal-actions">
            <button type="button" class="btn btn-ghost" id="i-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="i-submit">Join list</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('i-cancel').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });
  $('int-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('i-submit'); btn.disabled = true; btn.textContent = 'Joining…';
    $('i-err').style.display = 'none';
    try {
      const res = await registerInterest(product.id, {
        name: $('i-name').value.trim(), email: $('i-email').value.trim(),
        phone: $('i-phone').value.trim(), consent: $('i-consent').checked
      });
      $('i-ok').textContent = res.alreadyJoined ? "You're already on the list ✓" : "You're on the list! 🎉";
      $('i-ok').style.display = 'block';
      btn.textContent = 'Done';
      setTimeout(() => { close(); load(); }, 1100);
    } catch (err) {
      $('i-err').textContent = err.message || String(err);
      $('i-err').style.display = 'block';
      btn.disabled = false; btn.textContent = 'Join list';
    }
  });
}

let PRODUCTS = [];
async function load() {
  PRODUCTS = await listVisibleProducts();
  const grid = $('pre-grid');
  if (!PRODUCTS.length) {
    grid.innerHTML = `<div class="pre-empty">Nothing announced yet — join the early-access list below and you'll be first to know.</div>`;
    return;
  }
  grid.innerHTML = PRODUCTS.map(cardHtml).join('');
  grid.querySelectorAll('[data-interest]').forEach((b) => b.addEventListener('click', () => {
    const p = PRODUCTS.find((x) => x.id === b.getAttribute('data-interest'));
    if (p) openInterestModal(p);
  }));
}

function wireEarlyAccess() {
  $('early-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('ea-msg');
    msg.textContent = '';
    try {
      await joinEarlyAccess({
        name: $('ea-name').value.trim(), email: $('ea-email').value.trim(), consent: $('ea-consent').checked
      });
      msg.textContent = "You're on the early-access list! 🎉";
      msg.className = 'pre-msg ok';
      $('early-form').reset();
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = 'pre-msg err';
    }
  });
}

async function main() {
  if (!firebaseReady) { $('pre-grid').innerHTML = '<div class="pre-empty">Unable to load right now.</div>'; return; }
  wireEarlyAccess();
  await load();
}
main();
