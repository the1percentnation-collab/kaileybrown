// Admin: Products & Launches — CRUD + demand dashboard. Admin/owner only.

import { firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderTopbar } from './topbar.js';
import {
  PRODUCT_TYPES, PRODUCT_STATUSES,
  listAllProducts, createProduct, updateProduct, deleteProduct,
  listInterests, notifyLaunch, uploadProductImage, escapeHtml, fmtMoney
} from './products.js';

const $ = (id) => document.getElementById(id);
const state = { products: [] };

function gate(msg) { $('gate-msg').innerHTML = `<div class="card"><div class="auth-error">${escapeHtml(msg)}</div></div>`; }

function statusBadge(s) {
  const color = { planned: '#A8A8A8', interest: '#8A8A8A', preorder: '#2E2E2E', live: '#E31837', archived: '#C4C4C4' }[s] || '#A8A8A8';
  return `<span class="crm-stage-badge" style="--stage-color:${color}">${escapeHtml(s)}</span>`;
}

function render() {
  const totalInterest = state.products.reduce((s, p) => s + (p.interestCount || 0), 0);
  const potential = state.products.reduce((s, p) => s + (p.interestCount || 0) * (Number(p.price) || 0), 0);
  const preorders = state.products.reduce((s, p) => s + (p.preorderCount || 0), 0);
  const deposits = state.products.reduce((s, p) => s + (Number(p.depositTotal) || 0), 0);

  $('demand-summary').innerHTML = `
    <div class="crm-widget crm-widget-accent"><div class="crm-widget-label">Total interested</div><div class="crm-widget-value">${totalInterest}</div></div>
    <div class="crm-widget"><div class="crm-widget-label">Potential revenue</div><div class="crm-widget-value">${fmtMoney(potential) || '$0'}</div><div class="crm-widget-sub">interest × price</div></div>
    <div class="crm-widget"><div class="crm-widget-label">Pre-orders</div><div class="crm-widget-value">${preorders}</div></div>
    <div class="crm-widget"><div class="crm-widget-label">Deposits collected</div><div class="crm-widget-value">${fmtMoney(deposits) || '$0'}</div></div>
  `;

  const host = $('product-list');
  if (!state.products.length) {
    host.innerHTML = `<div class="card"><div class="crm-subpanel-empty">No products yet. Click “+ New Product” to add your first upcoming product.</div></div>`;
    return;
  }
  host.innerHTML = `<div class="card crm-list-card"><table class="data-table crm-list-table">
    <thead><tr><th>Product</th><th>Status</th><th>Price</th><th>Interested</th><th>Potential</th><th>Pre-orders</th><th></th></tr></thead>
    <tbody>
    ${state.products.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong><div class="crm-mini-sub">${escapeHtml(p.type || '')}</div></td>
        <td>${statusBadge(p.status)}</td>
        <td>${fmtMoney(p.price) || '—'}</td>
        <td>${p.interestCount || 0}</td>
        <td>${fmtMoney((p.interestCount || 0) * (Number(p.price) || 0)) || '—'}</td>
        <td>${p.preorderCount || 0}</td>
        <td style="white-space:nowrap;text-align:right;">
          <button class="crm-chip" data-view="${p.id}">Interested</button>
          <button class="crm-chip" data-notify="${p.id}">Notify</button>
          <button class="crm-chip" data-edit="${p.id}">Edit</button>
        </td>
      </tr>`).join('')}
    </tbody></table></div>`;

  host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(state.products.find((p) => p.id === b.getAttribute('data-edit')))));
  host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openInterestedModal(b.getAttribute('data-view'))));
  host.querySelectorAll('[data-notify]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.products.find((x) => x.id === b.getAttribute('data-notify'));
    if (!p) return;
    if (!confirm(`Email the ${p.interestCount || 0} interested people that "${p.name}" is available?`)) return;
    b.disabled = true; b.textContent = 'Sending…';
    try { const r = await notifyLaunch(p.id); alert(`Sent to ${r.sent || 0} people.`); }
    catch (e) { alert('Could not send: ' + (e.message || e)); }
    finally { b.disabled = false; b.textContent = 'Notify'; }
  }));
}

async function openInterestedModal(productId) {
  const root = $('modal-root');
  root.innerHTML = `<div class="crm-modal-backdrop" id="modal-bd"><div class="crm-modal auth-card"><h1>Interested</h1><div id="int-body">Loading…</div><div class="crm-modal-actions"><button class="btn btn-ghost" id="ic-close">Close</button></div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('ic-close').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });
  const rows = await listInterests(productId);
  $('int-body').innerHTML = rows.length
    ? rows.map((r) => `<div class="crm-mini-row"><div class="crm-mini-main"><div class="crm-mini-title">${escapeHtml(r.name || r.email)}</div><div class="crm-mini-sub">${escapeHtml(r.email)}${r.phone ? ' · ' + escapeHtml(r.phone) : ''}${r.consent ? ' · opted-in' : ''}</div></div></div>`).join('')
    : '<div class="crm-subpanel-empty">No signups yet.</div>';
}

function openModal(product) {
  const editing = !!product;
  const p = product || {};
  const root = $('modal-root');
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal auth-card">
        <h1>${editing ? 'Edit' : 'New'} <span>Product</span></h1>
        <form id="p-form" class="crm-form">
          <div class="crm-form-row"><label>Name *</label><input class="c-input" id="p-name" required value="${escapeHtml(p.name || '')}" /></div>
          <div class="crm-form-row"><label>Summary (1 line)</label><input class="c-input" id="p-summary" value="${escapeHtml(p.summary || '')}" /></div>
          <div class="crm-form-row"><label>Description</label><textarea class="c-input" id="p-desc" rows="3">${escapeHtml(p.description || '')}</textarea></div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row"><label>Type</label><select class="c-input crm-select" id="p-type">${PRODUCT_TYPES.map((t) => `<option value="${t}" ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="crm-form-row"><label>Status</label><select class="c-input crm-select" id="p-status">${PRODUCT_STATUSES.map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          </div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row"><label>Price ($)</label><input class="c-input" id="p-price" type="number" min="0" value="${p.price != null ? p.price : ''}" /></div>
            <div class="crm-form-row"><label>Sort order</label><input class="c-input" id="p-sort" type="number" value="${p.sortOrder || 0}" /></div>
          </div>
          <div class="crm-form-row">
            <label>Cover image</label>
            <div class="p-img-uploader">
              <div class="p-img-preview" id="p-img-preview">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="">` : '<span>No image</span>'}</div>
              <div class="p-img-controls">
                <label class="btn btn-ghost p-img-btn">Upload image<input type="file" id="p-image-file" accept="image/*" hidden></label>
                <span id="p-img-status" class="crm-save-status"></span>
                <input class="c-input" id="p-image" placeholder="…or paste an image URL" value="${escapeHtml(p.imageUrl || '')}" />
              </div>
            </div>
          </div>
          <div class="pre-modal-sub">Set status to <b>interest</b> or <b>preorder</b> to show it publicly on /upcoming. Flip to <b>live</b> to auto-email the interest list.</div>
          <div id="p-err" class="auth-error" style="display:none;"></div>
          <div class="crm-modal-actions">
            ${editing ? `<button type="button" class="btn btn-ghost" id="p-del" style="margin-right:auto;">Delete</button>` : ''}
            <button type="button" class="btn btn-ghost" id="p-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('p-cancel').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });
  if (editing) $('p-del').addEventListener('click', async () => {
    if (!confirm(`Delete "${p.name}"? This removes its interest list too.`)) return;
    await deleteProduct(p.id); close(); await reload();
  });

  // Image upload + preview (the #p-image text field stays the source of truth).
  const fileInput = $('p-image-file');
  const urlInput = $('p-image');
  const preview = $('p-img-preview');
  const imgStatus = $('p-img-status');
  const setPreview = (url) => { preview.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="">` : '<span>No image</span>'; };
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { imgStatus.textContent = 'Pick an image file'; imgStatus.className = 'crm-save-status err'; return; }
    try { setPreview(URL.createObjectURL(f)); } catch (_) {}
    imgStatus.textContent = 'Uploading…'; imgStatus.className = 'crm-save-status';
    try {
      const url = await uploadProductImage(f);
      urlInput.value = url;
      setPreview(url);
      imgStatus.textContent = 'Uploaded ✓'; imgStatus.className = 'crm-save-status ok';
    } catch (err) {
      imgStatus.textContent = 'Upload failed: ' + (err.message || err); imgStatus.className = 'crm-save-status err';
    }
  });
  urlInput.addEventListener('input', () => setPreview(urlInput.value.trim()));
  $('p-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      name: $('p-name').value, summary: $('p-summary').value || null, description: $('p-desc').value || null,
      type: $('p-type').value, status: $('p-status').value,
      price: $('p-price').value, sortOrder: $('p-sort').value, imageUrl: $('p-image').value || null
    };
    try {
      if (editing) await updateProduct(p.id, data); else await createProduct(data);
      close(); await reload();
    } catch (err) { $('p-err').textContent = err.message || String(err); $('p-err').style.display = ''; }
  });
}

async function reload() {
  state.products = await listAllProducts();
  render();
}

async function main() {
  if (!firebaseReady) { gate('Firebase is unavailable.'); return; }
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/manage-products.html')); return; }
  const info = await getRoleInfo(true);
  renderTopbar({ user: u, role: info.role, currentPage: null });
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  $('panel').style.display = 'block';
  $('btn-new-product').addEventListener('click', () => openModal(null));
  await reload();
}
main();
