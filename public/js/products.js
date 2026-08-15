// Products data layer — generic pre-order / interest items (top-level
// `products` collection). Public reads visible products; admins manage them.
// Interest/early-access signups + launch notify go through Cloud Functions.

import { app, auth, db, functions, firebaseReady } from './firebase.js';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, getDocs, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// Lazy storage (only pages that upload pay the cost).
let _storage = null;
function storage() {
  if (!_storage && firebaseReady) _storage = getStorage(app);
  return _storage;
}

// Upload a product image to Storage and return its public download URL.
export async function uploadProductImage(file) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const s = storage();
  if (!s) throw new Error('Storage unavailable');
  const ext = (file.name.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
  const safe = `${Date.now()}.${ext}`;
  const r = storageRef(s, `product-images/${user.uid}/${safe}`);
  await uploadBytes(r, file, { contentType: file.type || 'image/jpeg' });
  return await getDownloadURL(r);
}

export const PRODUCT_TYPES = ['course', 'book', 'physical', 'service', 'other'];
export const PRODUCT_STATUSES = ['planned', 'interest', 'preorder', 'live', 'archived'];
export const VISIBLE_STATUSES = ['interest', 'preorder', 'live'];

function productsCol() { return collection(db, 'products'); }
function productRef(id) { return doc(db, 'products', id); }

// Public: products visitors may see (interest/preorder/live).
export async function listVisibleProducts() {
  if (!firebaseReady) return [];
  try {
    const snap = await getDocs(query(productsCol(), where('status', 'in', VISIBLE_STATUSES)));
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return rows;
  } catch (e) { console.warn('[products] listVisible failed', e); return []; }
}

// Admin: every product.
export async function listAllProducts() {
  if (!firebaseReady) return [];
  try {
    const snap = await getDocs(productsCol());
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return rows;
  } catch (e) { console.warn('[products] listAll failed', e); return []; }
}

export async function getProduct(id) {
  if (!firebaseReady || !id) return null;
  const snap = await getDoc(productRef(id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createProduct(data = {}) {
  const payload = {
    name: (data.name || '').trim() || 'Untitled product',
    slug: (data.slug || '').trim() || null,
    type: PRODUCT_TYPES.includes(data.type) ? data.type : 'other',
    status: PRODUCT_STATUSES.includes(data.status) ? data.status : 'planned',
    summary: data.summary || null,
    description: data.description || null,
    imageUrl: data.imageUrl || null,
    price: data.price === '' || data.price == null ? null : Number(data.price),
    preorderMode: ['interest', 'deposit', 'prepay'].includes(data.preorderMode) ? data.preorderMode : 'interest',
    depositAmount: data.depositAmount ? Number(data.depositAmount) : null,
    launchAt: data.launchAt || null,
    sortOrder: Number(data.sortOrder) || 0,
    interestCount: 0,
    preorderCount: 0,
    depositTotal: 0,
    launchNotifiedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(productsCol(), payload);
  return { id: ref.id, ...payload };
}

export async function updateProduct(id, patch = {}) {
  const allowed = ['name', 'slug', 'type', 'status', 'summary', 'description', 'imageUrl',
    'price', 'preorderMode', 'depositAmount', 'launchAt', 'sortOrder'];
  const clean = {};
  allowed.forEach((k) => {
    if (patch[k] === undefined) return;
    if (k === 'price' || k === 'depositAmount') clean[k] = patch[k] === '' || patch[k] == null ? null : Number(patch[k]);
    else if (k === 'sortOrder') clean[k] = Number(patch[k]) || 0;
    else clean[k] = patch[k];
  });
  clean.updatedAt = serverTimestamp();
  await updateDoc(productRef(id), clean);
}

export async function deleteProduct(id) { await deleteDoc(productRef(id)); }

// Admin: read a product's interest list.
export async function listInterests(productId) {
  if (!firebaseReady || !productId) return [];
  try {
    const snap = await getDocs(collection(db, 'products', productId, 'interests'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('[products] listInterests failed', e); return []; }
}

// Public callables.
export async function registerInterest(productId, { name, email, phone, consent }) {
  const call = httpsCallable(functions, 'registerProductInterest');
  const res = await call({ productId, name, email, phone, consent });
  return res.data || { ok: true };
}
export async function joinEarlyAccess({ name, email, consent }) {
  const call = httpsCallable(functions, 'joinEarlyAccess');
  const res = await call({ name, email, consent });
  return res.data || { ok: true };
}
export async function notifyLaunch(productId) {
  const call = httpsCallable(functions, 'notifyProductInterest');
  const res = await call({ productId });
  return res.data || { ok: true };
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v) || !v) return null;
  try { return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }); }
  catch (e) { return '$' + Math.round(v); }
}
