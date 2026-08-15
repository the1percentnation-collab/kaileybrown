// /certificate.html?course=<slug> — the printable certificate of completion.
//
// Gate: signed in, enrolled (or admin), and every module of the course marked
// complete. Anything short of that gets the "not yet" panel with a way back
// into the course rather than a certificate.
//
// The issue date is frozen the first time the certificate is opened, in
// users/{uid}/certificates/{slug}. A reprint months later shows the day the
// member finished, not the day they reprinted.

import { loadCourses, getCourseBySlug } from './courses-data.js';
import { onAuthReady, currentUser } from './auth.js';
import { renderTopbar, renderTopbarEarly } from './topbar.js';
import { getRoleInfo } from './roles.js';
import { db, firebaseReady } from './firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getUserProfile, escapeHtml } from './community.js';
import { loadEnrollments, isEnrolled } from './enrollments.js';
import { loadCourseCompletion } from './course-progress.js';
import {
  certificateSheetHtml, certificateNumber, formatCertDate, CERT_SIGNER,
  certStylePickerHtml, normalizeCertStyle, DEFAULT_CERT_STYLE, CERT_STYLES
} from './certificate.js';

const $ = (id) => document.getElementById(id);

function slugParam() {
  return new URLSearchParams(location.search).get('course');
}

function panel(html) {
  const slot = $('cert-slot');
  if (slot) slot.innerHTML = html;
}

function messageHtml({ title, body, actions = '' }) {
  return `
    <div class="cert-message">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      ${actions ? `<div class="cert-message-actions">${actions}</div>` : ''}
    </div>`;
}

/** Name on the certificate: profile name first, then the auth record, then email. */
function memberName(profile, user) {
  const fromProfile = profile && typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
  if (fromProfile) return fromProfile;
  const fromAuth = user && typeof user.displayName === 'string' ? user.displayName.trim() : '';
  if (fromAuth) return fromAuth;
  const email = (user && user.email) || '';
  return email ? email.split('@')[0] : 'Member';
}

/**
 * Reads the stored certificate record, writing it on first view. Returns the
 * date to print and the style the member last chose. Failure is non-fatal —
 * the certificate still renders, dated today, rather than blocking on a write.
 */
async function certRecord(uid, course, name, certNumber) {
  const fallback = { date: new Date(), style: lsStyle() };
  if (!firebaseReady || !uid) return fallback;
  const ref = doc(db, 'users', uid, 'certificates', course.slug);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() || {};
      const issued = data.issuedAt && typeof data.issuedAt.toDate === 'function'
        ? data.issuedAt.toDate()
        : new Date();
      // A style saved on the record wins over this browser's copy — the choice
      // should follow the member to whichever device they print from.
      return { date: issued, style: data.style ? normalizeCertStyle(data.style) : lsStyle() };
    }
    await setDoc(ref, {
      courseSlug: course.slug,
      courseTitle: course.title || course.slug,
      certNumber,
      name,
      style: fallback.style,
      issuedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('[certificate] issue record failed', e);
  }
  return fallback;
}

const LS_STYLE_KEY = 'kb_cert_style';

function lsStyle() {
  try { return normalizeCertStyle(localStorage.getItem(LS_STYLE_KEY)); }
  catch (e) { return DEFAULT_CERT_STYLE; }
}

/** Persist the pick. Local first so it survives a signed-out reload, then remote. */
function saveStyle(uid, slug, style) {
  try { localStorage.setItem(LS_STYLE_KEY, style); } catch (e) {}
  if (!firebaseReady || !uid) return;
  setDoc(doc(db, 'users', uid, 'certificates', slug), { style }, { merge: true })
    .catch((e) => console.warn('[certificate] style save failed', e));
}

function actionsHtml(course) {
  return `
    <div class="cert-actions cert-noprint">
      <button class="btn btn-primary" id="cert-print">Print / Save as PDF</button>
      <a class="btn btn-ghost" href="/courses.html?course=${encodeURIComponent(course.slug)}">← Back to course</a>
    </div>`;
}

async function main() {
  let user = null;
  if (firebaseReady) {
    user = await onAuthReady();
    if (!user) {
      location.replace('/login.html');
      return;
    }
  }

  renderTopbarEarly({ user: currentUser(), currentPage: null, links: [] });

  try { await loadCourses(); } catch (e) {}
  try { await loadEnrollments(); } catch (e) {}

  let roleInfo = null;
  try { if (firebaseReady && currentUser()) roleInfo = await getRoleInfo(); } catch (e) {}
  const isAdmin = !!(roleInfo && roleInfo.isAdmin);

  const slug = slugParam();
  const course = slug ? getCourseBySlug(slug, { includeInactive: isAdmin }) : null;

  if (!course) {
    panel(messageHtml({
      title: 'Certificate not found',
      body: 'We could not find that course. Open it from your course library and try again.',
      actions: '<a class="btn btn-primary" href="/courses.html">Go to Course Library</a>'
    }));
  } else if (course.certificate === false) {
    panel(messageHtml({
      title: 'No certificate for this course',
      body: `${course.title} does not issue a certificate of completion.`,
      actions: `<a class="btn btn-primary" href="/courses.html?course=${encodeURIComponent(course.slug)}">Back to course</a>`
    }));
  } else if (!isEnrolled(course.slug) && !isAdmin) {
    panel(messageHtml({
      title: 'Not enrolled',
      body: `You are not enrolled in ${course.title}, so there is no certificate to issue yet.`,
      actions: '<a class="btn btn-primary" href="/courses.html">Go to Course Library</a>'
    }));
  } else {
    const { done, total, pct, isComplete } = await loadCourseCompletion(course);

    if (!isComplete) {
      const left = Math.max(total - done, 0);
      panel(messageHtml({
        title: 'Certificate not earned yet',
        body: total === 0
          ? `${course.title} has no lessons published yet, so there is nothing to certify.`
          : `You have completed ${done} of ${total} modules (${pct}%). Finish the remaining ${left} to unlock your certificate.`,
        actions: `<a class="btn btn-primary" href="/courses.html?course=${encodeURIComponent(course.slug)}">Continue the course →</a>`
      }));
    } else {
      const uid = currentUser() ? currentUser().uid : '';
      let profile = null;
      try { if (uid) profile = await getUserProfile(uid); } catch (e) {}
      const name = memberName(profile, currentUser());
      const certNumber = certificateNumber(uid, course.slug);
      const { date, style } = await certRecord(uid, course, name, certNumber);

      panel(
        certificateSheetHtml({
          name,
          courseTitle: course.title,
          dateLabel: formatCertDate(date),
          certNumber,
          signer: CERT_SIGNER,
          style
        }) +
        certStylePickerHtml(style) +
        actionsHtml(course) +
        `<p class="cert-note cert-noprint">The name above comes from your profile —
          <a href="/profile.html">update it there</a> if it should read differently.</p>`
      );

      const printBtn = $('cert-print');
      if (printBtn) printBtn.addEventListener('click', () => window.print());

      // Style switching is a class swap on the sheet — no re-render, so the
      // certificate never flickers while someone compares the options.
      const sheet = $('cert-sheet');
      const styleBtns = document.querySelectorAll('.cert-style');
      styleBtns.forEach((btn) => btn.addEventListener('click', () => {
        const picked = normalizeCertStyle(btn.dataset.style);
        if (sheet) {
          CERT_STYLES.forEach((s) => sheet.classList.remove(`is-${s.id}`));
          sheet.classList.add(`is-${picked}`);
        }
        styleBtns.forEach((b) => b.setAttribute('aria-pressed',
          b.dataset.style === picked ? 'true' : 'false'));
        saveStyle(uid, course.slug, picked);
      }));
    }
  }

  let profile = null;
  try {
    if (firebaseReady && currentUser()) profile = await getUserProfile(currentUser().uid);
  } catch (e) {}
  renderTopbar({
    user: currentUser(),
    profile,
    role: roleInfo ? roleInfo.role : null,
    currentPage: null,
    links: []
  });
}

main();
