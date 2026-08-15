// /course.html — Udemy-style course landing page, rendered from the course
// registry + Firestore overrides (courses-data.js). Publicly viewable; the
// enroll CTA routes through the same checkout/enroll flow as the library.
//
// Renders: breadcrumb → hero (title, subtitle, meta, rating strip) → sticky
// purchase card → What you'll learn → This course includes → Course content
// accordion → Requirements → Description → Instructor → More courses.

import { loadCourses, getCourses, getCourseBySlug, priceInfo } from './courses-data.js';
import { onAuthReady, currentUser } from './auth.js';
import { firebaseReady, functions } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { escapeHtml, getUserProfile } from './community.js';
import { renderTopbar } from './topbar.js';
import { loadEnrollments, isEnrolled, enrollInCourse } from './enrollments.js';
import { getRefCode } from './referral.js';

const root = () => document.getElementById('cl-root');

// TODO(brand): replace `title` and `bio` with Kailey's real positioning copy.
// This renders on every course landing page, above the fold.
const INSTRUCTOR = {
  name: 'Kailey Brown',
  title: 'Founder, Kailey Brown',
  bio: 'Kailey teaches a practical approach to growth: clear principles, applied ' +
    'the same day, measured over time. Every course in the Academy follows the ' +
    'same structure — learn the idea, put it to work, and track what changes.'
};

// ─── Duration helpers ─────────────────────────────────────────────────────

function toMinutes(d) {
  if (!d) return 0;
  const m = String(d).match(/(\d+)\s*(hr|hour|h)/i);
  const mins = String(d).match(/(\d+)\s*min/i);
  let total = 0;
  if (m) total += Number(m[1]) * 60;
  if (mins) total += Number(mins[1]);
  return total;
}

function fmtTotal(mins) {
  if (!mins) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m ? m + 'm' : ''}`.trim() : `${m}min`;
}

function curriculumStats(curriculum) {
  const sections = curriculum.length;
  let lessons = 0;
  let mins = 0;
  curriculum.forEach((s) => (s.lessons || []).forEach((l) => { lessons += 1; mins += toMinutes(l.d); }));
  return { sections, lessons, mins };
}

// ─── Section templates ────────────────────────────────────────────────────

function heroHtml(course) {
  const p = priceInfo(course);
  const isNew = !(course.ratingAvg && course.ratingCount);
  const ratingStrip = `
    <div class="cl-strip">
      ${isNew
        ? `<div class="cl-strip-cell"><span class="cl-badge-new">New</span><span class="cl-strip-label">recently added</span></div>`
        : `<div class="cl-strip-cell"><span class="cl-strip-big">${Number(course.ratingAvg).toFixed(1)}</span>
             <span class="cl-stars" aria-label="${Number(course.ratingAvg).toFixed(1)} out of 5">★★★★★</span>
             <span class="cl-strip-label">${escapeHtml(String(course.ratingCount))} ratings</span></div>`}
      ${typeof course.learners === 'number'
        ? `<div class="cl-strip-cell"><span class="cl-strip-big">${course.learners.toLocaleString()}</span><span class="cl-strip-label">learners</span></div>`
        : ''}
      <div class="cl-strip-cell"><span class="cl-strip-big">${escapeHtml(fmtTotal(curriculumStats(course.curriculum || []).mins) || '—')}</span><span class="cl-strip-label">of content</span></div>
    </div>`;

  return `
    <div class="cl-hero">
      <div class="cl-hero-inner">
        <div class="cl-hero-main">
          <a class="cl-back" href="/courses.html"><span class="cl-back-arrow">←</span> Back to courses</a>
          <nav class="cl-breadcrumb" aria-label="Breadcrumb">
            <a href="/dashboard.html">Academy</a> <span>›</span>
            <a href="/courses.html">Courses</a> <span>›</span>
            <a href="/courses.html">${escapeHtml(course.category || 'All Courses')}</a>
          </nav>
          <h1 class="cl-title">${escapeHtml(course.title)}</h1>
          <p class="cl-subtitle">${escapeHtml(course.subtitle || '')}</p>
          <div class="cl-meta">
            <span>Created by <a href="https://kaileybrown.com" target="_blank" rel="noopener">${escapeHtml(INSTRUCTOR.name)}</a></span>
            ${course.lastUpdated ? `<span class="cl-meta-item">🗓 Last updated ${escapeHtml(course.lastUpdated)}</span>` : ''}
            <span class="cl-meta-item">🌐 English</span>
            ${p.onSale ? `<span class="cl-badge-sale">Sale</span>` : ''}
          </div>
          ${ratingStrip}
        </div>
      </div>
    </div>`;
}

function learnHtml(course) {
  const items = course.whatYoullLearn || [];
  if (!items.length) return '';
  return `
    <section class="cl-card">
      <h2 class="cl-h2">What you'll learn</h2>
      <ul class="cl-learn-grid">
        ${items.map((i) => `<li><span class="cl-check">✓</span>${escapeHtml(i)}</li>`).join('')}
      </ul>
    </section>`;
}

const INCLUDE_ICONS = [
  [/book/i, '📕'], [/assess/i, '📊'], [/rewire|practice|challenge/i, '🔁'],
  [/certificat/i, '🏆'], [/lifetime|access/i, '♾'], [/module|lesson|on-demand/i, '▶'],
  [/worksheet|guide/i, '📝'], [/practicum|live/i, '🎤']
];

function includeIcon(label) {
  for (const [re, icon] of INCLUDE_ICONS) if (re.test(label)) return icon;
  return '•';
}

function includesHtml(course) {
  const items = course.includes || [];
  if (!items.length) return '';
  const half = Math.ceil(items.length / 2);
  const li = (i) => `<li><span class="cl-inc-icon">${includeIcon(i)}</span>${escapeHtml(i)}</li>`;
  return `
    <section class="cl-block">
      <h2 class="cl-h2">This course includes:</h2>
      <div class="cl-includes">
        <ul>${items.slice(0, half).map(li).join('')}</ul>
        <ul>${items.slice(half).map(li).join('')}</ul>
      </div>
    </section>`;
}

function kindTag(kind) {
  if (kind === 'assessment') return '<span class="cl-lesson-tag is-assess">Assessment</span>';
  if (kind === 'practice') return '<span class="cl-lesson-tag is-practice">Rewirement</span>';
  return '';
}

function curriculumHtml(course) {
  const cur = course.curriculum || [];
  if (!cur.length) return '';
  const stats = curriculumStats(cur);
  const sections = cur.map((s, i) => {
    const mins = (s.lessons || []).reduce((a, l) => a + toMinutes(l.d), 0);
    return `
      <details class="cl-sec"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="cl-sec-chev">›</span>
          <span class="cl-sec-title">${escapeHtml(s.title)}</span>
          <span class="cl-sec-meta">${s.lessons.length} lessons${mins ? ` · ${fmtTotal(mins)}` : ''}</span>
        </summary>
        <ul class="cl-lessons">
          ${s.lessons.map((l) => `
            <li>
              <span class="cl-lesson-icon">${l.kind === 'assessment' ? '📊' : l.kind === 'practice' ? '🔁' : '▶'}</span>
              <span class="cl-lesson-title">${escapeHtml(l.t)}</span>
              ${kindTag(l.kind)}
              <span class="cl-lesson-dur">${escapeHtml(l.d || '')}</span>
            </li>`).join('')}
        </ul>
      </details>`;
  }).join('');

  return `
    <section class="cl-block" id="cl-curriculum">
      <h2 class="cl-h2">Course content</h2>
      <div class="cl-cur-head">
        <span>${stats.sections} sections · ${stats.lessons} lessons${stats.mins ? ` · ${fmtTotal(stats.mins)} total length` : ''}</span>
        <button type="button" class="cl-expand" id="cl-expand-all">Expand all sections</button>
      </div>
      <div class="cl-accordion">${sections}</div>
    </section>`;
}

function requirementsHtml(course) {
  const items = course.requirements || [];
  if (!items.length) return '';
  return `
    <section class="cl-block">
      <h2 class="cl-h2">Requirements</h2>
      <ul class="cl-bullets">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
    </section>`;
}

function descriptionHtml(course) {
  const paras = course.description || [];
  if (!paras.length) return '';
  // Paragraphs are trusted registry/owner content; only <b>/<i>/<br> pass through.
  const clean = (s) => escapeHtml(s)
    .replace(/&lt;(\/?)(b|i|br)&gt;/g, '<$1$2>');
  return `
    <section class="cl-block">
      <h2 class="cl-h2">Description</h2>
      <div class="cl-desc is-clamped" id="cl-desc">
        ${paras.map((p) => `<p>${clean(p)}</p>`).join('')}
        <div class="cl-desc-fade"></div>
      </div>
      <button type="button" class="cl-expand" id="cl-desc-more">Show more ⌄</button>
    </section>`;
}

function methodHtml() {
  return `
    <section class="cl-block cl-method">
      <h2 class="cl-h2">How every course works</h2>
      <div class="cl-method-grid">
        <div class="cl-method-step"><span class="cl-method-num">01</span>
          <h3>Baseline</h3><p>Take a short self-assessment before lesson one, so your progress is measured rather than assumed.</p></div>
        <div class="cl-method-step"><span class="cl-method-num">02</span>
          <h3>Learn</h3><p>Short, plain-language lessons that teach one principle at a time.</p></div>
        <div class="cl-method-step"><span class="cl-method-num">03</span>
          <h3>Apply</h3><p>Every lesson ends with one small practice you put into your real life the same day.</p></div>
        <div class="cl-method-step"><span class="cl-method-num">04</span>
          <h3>Measure</h3><p>Retake the assessment at the end and see what actually changed.</p></div>
      </div>
    </section>`;
}

function instructorHtml() {
  return `
    <section class="cl-block">
      <h2 class="cl-h2">Instructor</h2>
      <div class="cl-instructor">
        <div class="cl-instructor-avatar">AB</div>
        <div>
          <div class="cl-instructor-name">${escapeHtml(INSTRUCTOR.name)}</div>
          <div class="cl-instructor-title">${escapeHtml(INSTRUCTOR.title)}</div>
          <p class="cl-instructor-bio">${escapeHtml(INSTRUCTOR.bio)}</p>
        </div>
      </div>
    </section>`;
}

function moreCoursesHtml(course) {
  const others = getCourses().filter((c) => c.slug !== course.slug).slice(0, 5);
  if (!others.length) return '';
  const rows = others.map((c) => {
    const p = priceInfo(c);
    return `
      <a class="cl-more-row" href="/course.html?course=${encodeURIComponent(c.slug)}">
        <span class="cl-more-thumb">${escapeHtml((c.short || c.title).slice(0, 2).toUpperCase())}</span>
        <span class="cl-more-body">
          <span class="cl-more-title">${escapeHtml(c.title)}</span>
          <span class="cl-more-meta">
            <span class="cl-more-badge">${escapeHtml(c.eyebrow || '')}</span>
          </span>
        </span>
        <span class="cl-more-price">${p.onSale ? `<s>${escapeHtml(p.originalLabel)}</s> ` : ''}${escapeHtml(p.label || '')}</span>
      </a>`;
  }).join('');
  return `
    <section class="cl-block">
      <h2 class="cl-h2">Members also explore</h2>
      <div class="cl-more">${rows}</div>
    </section>`;
}

// ─── Purchase card ────────────────────────────────────────────────────────

function purchaseCardHtml(course, { enrolled }) {
  const p = priceInfo(course);
  const isBundle = course.status === 'bundle' || !!course.bundleHref;
  const live = course.status === 'live';

  let cta;
  if (enrolled) {
    cta = `<a class="cl-cta" href="/courses.html?course=${encodeURIComponent(course.slug)}">Go to course →</a>`;
  } else if (isBundle) {
    cta = `<a class="cl-cta" href="${escapeHtml(course.bundleHref || `/course.html?slug=${encodeURIComponent(course.slug)}`)}">See bundle deal →</a>`;
  } else if (live) {
    cta = `<button class="cl-cta" id="cl-enroll">${p.isFree ? 'Enroll free' : 'Enroll now'}</button>`;
  } else {
    cta = `<button class="cl-cta" id="cl-notify">Notify me when enrollment opens</button>`;
  }

  const priceHtml = enrolled ? '' : `
    <div class="cl-price">
      <span class="cl-price-now">${escapeHtml(p.label || '')}</span>
      ${p.onSale ? `<s class="cl-price-was">${escapeHtml(p.originalLabel)}</s>` : ''}
    </div>
    ${course.priceNote ? `<div class="cl-price-note">${escapeHtml(course.priceNote)}</div>` : ''}
    ${!live && !isBundle ? `<div class="cl-soon-note">Coming soon — enrollment isn't open yet.</div>` : ''}`;

  return `
    <aside class="cl-buy" id="cl-buy">
      <div class="cl-buy-media">
        <span class="cl-buy-media-mark">${escapeHtml((course.short || course.title).slice(0, 12))}</span>
        <span class="cl-buy-media-eyebrow">${escapeHtml(course.eyebrow || '')}</span>
      </div>
      <div class="cl-buy-body">
        ${priceHtml}
        ${cta}
        <div id="cl-cta-msg" class="cl-cta-msg"></div>
        <ul class="cl-buy-perks">
          <li>Learn → Rewire → Measure method</li>
          <li>Self-paced · lifetime access</li>
          <li>Works on desktop and mobile</li>
        </ul>
        <div class="cl-buy-links">
          <span class="cl-coupon" title="Coupon codes are redeemed on the secure checkout page.">Have a coupon? Apply it at checkout</span>
          <button type="button" class="cl-share" id="cl-share" aria-label="Share this course">Share ↗</button>
        </div>
      </div>
    </aside>`;
}

// ─── Behavior ─────────────────────────────────────────────────────────────

function bindAccordion() {
  const btn = document.getElementById('cl-expand-all');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const secs = Array.from(document.querySelectorAll('.cl-sec'));
    const anyClosed = secs.some((s) => !s.open);
    secs.forEach((s) => { s.open = anyClosed; });
    btn.textContent = anyClosed ? 'Collapse all sections' : 'Expand all sections';
  });
}

function bindDescription() {
  const desc = document.getElementById('cl-desc');
  const btn = document.getElementById('cl-desc-more');
  if (!desc || !btn) return;
  // No clamp needed for short descriptions.
  if (desc.scrollHeight <= 320) {
    desc.classList.remove('is-clamped');
    btn.remove();
    return;
  }
  btn.addEventListener('click', () => {
    const clamped = desc.classList.toggle('is-clamped');
    btn.textContent = clamped ? 'Show more ⌄' : 'Show less ⌃';
  });
}

function bindShare(course) {
  const btn = document.getElementById('cl-share');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = location.origin + '/course.html?course=' + encodeURIComponent(course.slug);
    try {
      if (navigator.share) {
        await navigator.share({ title: course.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        btn.textContent = '✓ Link copied';
        setTimeout(() => { btn.textContent = 'Share ↗'; }, 2000);
      }
    } catch (e) { /* user dismissed */ }
  });
}

function ctaMsg(text) {
  const el = document.getElementById('cl-cta-msg');
  if (el) el.textContent = text || '';
}

function requireLoginRedirect() {
  location.assign('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
}

function bindEnroll(course) {
  const btn = document.getElementById('cl-enroll');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (firebaseReady && !currentUser()) { requireLoginRedirect(); return; }
    const p = priceInfo(course);
    btn.disabled = true;
    btn.textContent = p.isFree ? 'Enrolling…' : 'Opening secure checkout…';
    try {
      if (p.isFree || !firebaseReady) {
        await enrollInCourse(course.slug);
        location.assign(`/courses.html?course=${encodeURIComponent(course.slug)}`);
      } else {
        const res = await httpsCallable(functions, 'createCheckoutSession')({
          slug: course.slug,
          refCode: getRefCode() || undefined
        });
        const url = res && res.data && res.data.url;
        if (!url) throw new Error('Checkout could not be started.');
        location.assign(url);
      }
    } catch (err) {
      console.warn('[course-landing] enroll failed', err);
      btn.disabled = false;
      btn.textContent = p.isFree ? 'Enroll free' : 'Enroll now';
      ctaMsg(err.message || 'Could not start enrollment. Please try again.');
    }
  });
}

function bindNotify(course) {
  const btn = document.getElementById('cl-notify');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (firebaseReady && !currentUser()) { requireLoginRedirect(); return; }
    btn.disabled = true;
    btn.textContent = 'Adding you…';
    try {
      await httpsCallable(functions, 'registerCourseInterest')({ slug: course.slug, title: course.title });
      btn.textContent = "✓ You're on the list";
    } catch (err) {
      console.warn('[course-landing] notify failed', err);
      btn.disabled = false;
      btn.textContent = 'Notify me when enrollment opens';
      ctaMsg(err.message || 'Could not add you to the waitlist. Please try again.');
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

function notFoundHtml() {
  return `
    <div class="cl-body"><div class="cl-block" style="text-align:center; padding:80px 20px;">
      <h1 class="cl-title" style="font-size:34px;">Course not found</h1>
      <p class="cl-subtitle">This course may have moved or is no longer available.</p>
      <a class="btn btn-primary" href="/courses.html" style="margin-top:16px; display:inline-block;">Browse the Course Library →</a>
    </div></div>`;
}

async function main() {
  // Publicly viewable — never redirect to login just for looking, and never
  // block rendering on a slow auth handshake (race against a short timeout;
  // the CTA re-checks currentUser() at click time anyway).
  const withTimeout = (p, ms) => Promise.race([
    p, new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);

  let user = null;
  if (firebaseReady) {
    try { user = await withTimeout(onAuthReady(), 4000); } catch (e) {}
  }

  // If Firestore is slow/unreachable, render from the built-in registry
  // (getCourses falls back to the seed data automatically).
  try { await withTimeout(loadCourses(), 5000); } catch (e) {}
  try { if (user) await withTimeout(loadEnrollments(), 4000); } catch (e) {}

  const slug = new URLSearchParams(location.search).get('course');
  const course = getCourseBySlug(slug, { includeInactive: false });

  if (!course) {
    root().innerHTML = notFoundHtml();
    return;
  }

  document.title = `${course.title} | Kailey Brown Academy`;
  const enrolled = !!user && isEnrolled(course.slug);

  root().innerHTML = `
    ${heroHtml(course)}
    <div class="cl-body">
      <div class="cl-cols">
        <div class="cl-main">
          ${learnHtml(course)}
          ${methodHtml()}
          ${includesHtml(course)}
          ${curriculumHtml(course)}
          ${requirementsHtml(course)}
          ${descriptionHtml(course)}
          ${instructorHtml()}
          ${moreCoursesHtml(course)}
        </div>
        ${purchaseCardHtml(course, { enrolled })}
      </div>
    </div>`;

  bindAccordion();
  bindDescription();
  bindShare(course);
  bindEnroll(course);
  bindNotify(course);

  // Header user chip (no duplicate nav links — the tabs handle navigation).
  try {
    let profile = null;
    if (user) { try { profile = await getUserProfile(user.uid); } catch (e) {} }
    renderTopbar({ user, profile, role: null, currentPage: null, links: [] });
  } catch (e) {}
}

main();
