// Enrollments — tracks which courses the signed-in user has signed up for.
//
// Storage: `users/{uid}.enrolledCourseSlugs` (array). Enrollment writes are
// SERVER-SIDE: free courses go through the `enrollFree` callable and paid
// courses are written by the Stripe webhook after checkout. Firestore rules
// freeze `enrolledCourseSlugs` on self-updates.
//
// Fallback: localStorage when Firebase is unavailable (offline read cache).

import { auth, db, functions, firebaseReady } from './firebase.js';
import {
  doc, getDoc, collection, getDocs, limit, query
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { loadCourses, getCourses, getCourseBySlug, priceInfo } from './courses-data.js';

const LS_KEY = 'kb_academy_enrollments';

let _cache = null;
let _cacheUid = null;

function lsGet() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function lsSet(set) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(set))); } catch (e) {}
}

export async function loadEnrollments({ force = false } = {}) {
  // Make sure the merged course list is ready for enrolledCourses() etc.
  try { await loadCourses(); } catch (e) {}

  if (!firebaseReady || !auth || !auth.currentUser) {
    // Offline / signed-out: local cache is all we have.
    _cache = lsGet();
    _cacheUid = null;
    return _cache;
  }

  const uid = auth.currentUser.uid;
  if (!force && _cacheUid === uid && _cache) return _cache;

  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const data = snap.exists() ? snap.data() : {};
    const slugs = Array.isArray(data.enrolledCourseSlugs) ? data.enrolledCourseSlugs : [];
    // Firestore is authoritative — the local cache is only a fallback when
    // remote reads fail (merging it in would let users grant themselves
    // paid-course access via localStorage).
    _cache = new Set(slugs);
    _cacheUid = uid;
    lsSet(_cache);
  } catch (e) {
    console.warn('[enrollments] load failed, using local cache', e);
    _cache = lsGet();
  }

  return _cache;
}

// Enrolls the current user in a FREE live course (server-side via callable).
// Paid courses must go through checkout — see startCheckout in courses-page.
export async function enrollInCourse(slug) {
  await loadCourses();
  const known = getCourseBySlug(slug);
  if (!known) throw new Error(`Unknown course: ${slug}`);
  if (known.status !== 'live') throw new Error('This course isn\'t available to join yet.');

  const price = priceInfo(known);
  if (!price.isFree && firebaseReady) {
    throw new Error('This course requires checkout to enroll.');
  }

  if (firebaseReady && auth && auth.currentUser) {
    await httpsCallable(functions, 'enrollFree')({ slug });
  }

  if (!_cache) _cache = new Set();
  _cache.add(slug);
  lsSet(_cache);
}

export function isEnrolled(slug) {
  return _cache ? _cache.has(slug) : false;
}

export function enrolledCourses() {
  const set = _cache || new Set();
  return getCourses().filter((c) => set.has(c.slug));
}

export function availableCourses() {
  const set = _cache || new Set();
  return getCourses().filter((c) => !set.has(c.slug));
}
