// Onboarding gate — members must complete the info form once before they can
// use the portal. Staff (owner/admin) are exempt since they manage the system
// rather than enrol as members. Fails open on transient errors so a flaky read
// never locks anyone out of the portal.

import { db, firebaseReady } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/**
 * Returns true if the caller may proceed. If the member still needs to
 * onboard, this redirects to /onboarding.html (preserving where they were
 * headed via ?next=) and returns false — callers should `return` when false.
 */
export async function ensureOnboarded(user) {
  if (!firebaseReady || !user) return true;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    const d = snap.exists() ? snap.data() : {};
    const role = d.role || 'user';
    if (role === 'owner' || role === 'admin') return true;
    if (d.onboardingComplete === true) return true;
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/onboarding.html?next=${next}`);
    return false;
  } catch (e) {
    console.warn('[onboarding-guard] check failed, allowing through', e);
    return true;
  }
}
