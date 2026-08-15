// /courses.html orchestrator.
//
// Flow:
//   /courses.html               → welcome + "Available Courses" grid; sidebar
//                                 lists the user's enrolled courses only.
//   /courses.html?course=X      → roadmap for the enrolled course X. Click a
//                                 step to open that module.
//   /courses.html?course=X&module=N
//                               → opens module N of course X (actual lesson).
//
// Access gating: if X isn't in the user's enrollments, the welcome view
// is shown with a message. Nothing auto-opens; the user always chooses.

import { loadCourses, getCourseBySlug, priceInfo } from './courses-data.js';
import { onAuthReady, currentUser } from './auth.js';
import { renderTopbar, renderTopbarEarly } from './topbar.js';
import { getRoleInfo } from './roles.js';
import { firebaseReady, functions } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { getUserProfile, avatarHtml, escapeHtml } from './community.js';
import { store } from './store.js';
import { loadEnrollments, enrollInCourse, isEnrolled, enrolledCourses, availableCourses } from './enrollments.js';
import { getRefCode } from './referral.js';
import { certificateHref, courseCompleteHtml } from './certificate.js';
import { loadCourseCompletion } from './course-progress.js';
import { ensureOnboarded } from './onboarding-guard.js';
import { db } from './firebase.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

// Course slugs the current member has already joined the waitlist for.
const courseInterests = new Set();

async function loadCourseInterests() {
  courseInterests.clear();
  const user = currentUser();
  if (!firebaseReady || !user) return;
  try {
    const snap = await getDocs(collection(db, 'users', user.uid, 'courseInterests'));
    snap.forEach((d) => courseInterests.add(d.id));
  } catch (e) { /* non-fatal */ }
}

function urlParam(name) {
  const v = new URLSearchParams(location.search).get(name);
  return v == null ? null : v;
}

function courseSlug() { return urlParam('course'); }
// null = no module requested → roadmap view. The raw value has to be checked
// BEFORE coercing: Number(null) is 0, which is a valid module id, so coercing
// first made every ?course=X land straight in the player at module 0 and the
// roadmap never rendered at all.
function moduleParam() {
  const raw = urlParam('module');
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────

function sidebarEntryHtml(course, { isActive, completedCount = 0 } = {}) {
  const href = `/courses.html?course=${encodeURIComponent(course.slug)}`;
  let chip = '';
  if (course.slug === '1p-clc') {
    const total = course.moduleCount || 7;
    const pct = Math.round((completedCount / total) * 100);
    chip = `<span class="course-entry-pct">${pct}%</span>`;
  }
  return `
    <div class="course-entry ${isActive ? 'active' : ''}" data-slug="${escapeHtml(course.slug)}">
      <a class="course-entry-head" href="${href}">
        <span class="course-entry-indicator"></span>
        <span class="course-entry-meta">
          <span class="course-entry-title">${escapeHtml(course.short || course.title)}</span>
          <span class="course-entry-sub">${escapeHtml(course.eyebrow || '')}</span>
        </span>
        ${chip}
      </a>
    </div>
  `;
}

function renderSidebar(activeSlug) {
  const list = $('courses-sidebar-list');
  if (!list) return;
  const enrolled = enrolledCourses();
  const completedCount = store.completed ? store.completed.size : 0;

  if (enrolled.length === 0) {
    list.innerHTML = `
      <div class="courses-sidebar-empty">
        <div class="courses-sidebar-empty-eyebrow">No courses yet</div>
        <p>Sign up for a course from the welcome panel to see it here.</p>
      </div>
    `;
    return;
  }

  const entries = enrolled.map((c) => sidebarEntryHtml(c, {
    isActive: c.slug === activeSlug,
    completedCount
  })).join('');

  list.innerHTML = entries + `
    <a class="courses-sidebar-browse" href="/courses.html">
      <span>+ Browse all courses</span>
    </a>
  `;
}

// ─── Welcome + Available Courses ─────────────────────────────────────────

// One modern library card. The cover is generated on-brand (big display
// title over a dark/red gradient); a Firestore `image` field replaces it
// with real cover art without a deploy.
function courseCardHtml(c, { action, statusBadge, saleBadge = '', soon = false } = {}) {
  const p = priceInfo(c);
  // eyebrow is "Format · N Modules" — split it into the meta row.
  const [fmt, mods] = String(c.eyebrow || '').split('·').map((s) => s.trim());
  // `coverImage` is what the course builder's Sales tab writes; `image` is the
  // older Firestore-only field. Honour both so a cover set in the builder
  // actually reaches the member-facing library card.
  const coverSrc = c.image || c.coverImage;
  const cover = coverSrc
    ? `<div class="course-card-cover has-image" style="background-image:url('${escapeHtml(coverSrc)}')">`
    : `<div class="course-card-cover"><span class="course-card-cover-title">${escapeHtml(c.short || c.title)}</span>`;
  const price = p.label ? `
    <div class="course-card-price">
      ${p.onSale ? `<s>${escapeHtml(p.originalLabel)}</s>` : ''}
      <span>${escapeHtml(p.label)}</span>
    </div>` : '<div class="course-card-price"></div>';
  const priceNote = c.priceNote ? `<div class="course-card-note">${escapeHtml(c.priceNote)}</div>` : '';
  const searchText = [c.title, c.short, c.category, c.subtitle, c.eyebrow]
    .filter(Boolean).join(' ').toLowerCase();
  return `
    <article class="course-card${soon ? ' is-soon' : ''}"
             data-slug="${escapeHtml(c.slug)}" data-search="${escapeHtml(searchText)}">
      ${cover}
      </div>
      <div class="course-card-body">
        <div class="course-card-category">${escapeHtml(c.category || fmt || 'Course')}</div>
        <h3 class="course-card-title">${escapeHtml(c.title)}</h3>
        <div class="course-card-badges">${statusBadge}${saleBadge}</div>
        <p class="course-card-desc">${escapeHtml(c.subtitle || '')}</p>
        <div class="course-card-meta">
          <span>${escapeHtml(fmt || 'Self-paced')}</span>
          ${mods ? `<span>${escapeHtml(mods)}</span>` : ''}
        </div>
      </div>
      <div class="course-card-foot">
        ${price}
        ${action}
        ${priceNote}
      </div>
    </article>
  `;
}

function renderAvailableCourses() {
  const slot = $('welcome-available');
  if (!slot) return;

  const available = availableCourses();
  const enrolled = enrolledCourses();
  if (available.length === 0) {
    slot.innerHTML = enrolled.length > 0 ? `
      <div class="available-empty">You're enrolled in every course we offer. Keep going.</div>
    ` : '';
    return;
  }

  const cards = available.map((c) => {
    const isBundle = c.status === 'bundle';
    const isLive   = c.status === 'live';
    const statusBadge = isBundle
      ? `<span class="course-badge is-bundle">★ Best Value</span>`
      : isLive
        ? `<span class="course-badge is-live">Available</span>`
        : `<span class="course-badge is-soon">Coming Soon</span>`;
    const p = priceInfo(c);
    const saleBadge = p.onSale ? `<span class="course-badge is-sale">Sale</span>` : '';
    const joined = courseInterests.has(c.slug);
    const action = isBundle
      ? `<a class="course-card-btn available-bundle-link" href="${escapeHtml(c.bundleHref || '/bundle.html')}">See Bundle ↗</a>`
      : isLive
        ? `<button class="course-card-btn available-enroll" data-slug="${escapeHtml(c.slug)}">${p.isFree ? 'Join Free' : 'Join Course'}</button>`
        : `<button class="course-card-btn available-notify${joined ? ' is-joined' : ''}" data-slug="${escapeHtml(c.slug)}" data-title="${escapeHtml(c.title)}"${joined ? ' disabled' : ''}>${joined ? "✓ You're on the list" : 'Notify me when live'}</button>`;
    return courseCardHtml(c, { action, statusBadge, saleBadge, soon: !isLive });
  }).join('');

  // Enrolled courses live here — above the library.
  const myCards = enrolled.map((c) => courseCardHtml(c, {
    statusBadge: `<span class="course-badge is-live">Enrolled</span>`,
    action: `<a class="course-card-btn" href="/courses.html?course=${encodeURIComponent(c.slug)}">Continue →</a>`
  })).join('');
  const mySection = enrolled.length ? `
    <div class="library-head">
      <div class="library-head-text">
        <div class="academy-eyebrow">Continue Learning</div>
        <h2 class="library-title">Your <span>courses</span></h2>
      </div>
      <span class="library-count">${enrolled.length} enrolled</span>
    </div>
    <div class="course-grid" style="margin-bottom:64px;">${myCards}</div>
  ` : '';

  slot.innerHTML = mySection + `
    <div class="library-head">
      <div class="library-head-text">
        <div class="academy-eyebrow">Course Library</div>
        <h2 class="library-title">Explore our <span>courses</span></h2>
      </div>
      <div class="library-search" role="search">
        <input type="search" id="course-search" placeholder="Search courses…" aria-label="Search courses" autocomplete="off">
        <span class="library-search-icon" aria-hidden="true">⌕</span>
      </div>
    </div>
    <div class="course-grid" id="library-grid">${cards}</div>
    <div class="available-empty" id="library-empty" hidden></div>
  `;

  // Live search — filters the library grid as you type.
  const search = $('course-search');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    slot.querySelectorAll('#library-grid .course-card').forEach((card) => {
      const hit = !q || (card.dataset.search || '').includes(q);
      card.hidden = !hit;
      if (hit) shown++;
    });
    const empty = $('library-empty');
    if (empty) {
      empty.hidden = shown > 0;
      empty.textContent = `No courses match “${search.value.trim()}”.`;
    }
  });

  // Card click (anywhere except a button/link) opens the course detail page.
  slot.querySelectorAll('.course-card').forEach((card) => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      location.assign(`/course.html?course=${encodeURIComponent(card.dataset.slug)}`);
    });
  });

  slot.querySelectorAll('.available-enroll').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const slug = btn.dataset.slug;
      const course = getCourseBySlug(slug);
      const p = course ? priceInfo(course) : { isFree: true };
      btn.disabled = true;
      btn.textContent = p.isFree ? 'Enrolling…' : 'Opening secure checkout…';
      try {
        if (p.isFree || !firebaseReady) {
          await enrollInCourse(slug);
          // Reload to show the course in the sidebar + open its roadmap.
          location.assign(`/courses.html?course=${encodeURIComponent(slug)}`);
        } else {
          const res = await httpsCallable(functions, 'createCheckoutSession')({
            slug,
            refCode: getRefCode() || undefined
          });
          const url = res && res.data && res.data.url;
          if (!url) throw new Error('Checkout could not be started.');
          location.assign(url);
        }
      } catch (err) {
        console.warn('[courses-page] enroll failed', err);
        btn.disabled = false;
        btn.textContent = 'Sign up →';
        alert(err.message || 'Could not enroll. Please try again.');
      }
    });
  });

  slot.querySelectorAll('.available-notify').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('is-joined')) return;
      const slug = btn.dataset.slug;
      const title = btn.dataset.title || slug;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Adding you…';
      try {
        await httpsCallable(functions, 'registerCourseInterest')({ slug, title });
        courseInterests.add(slug);
        btn.classList.add('is-joined');
        btn.textContent = "✓ You're on the list";
      } catch (err) {
        console.warn('[courses-page] notify failed', err);
        btn.disabled = false;
        btn.textContent = prev;
        alert(err.message || 'Could not add you to the waitlist. Please try again.');
      }
    });
  });
}

// ─── Roadmap ─────────────────────────────────────────────────────────────

const DRAFT_CHIP = '<span style="display:inline-block; margin-left:8px; padding:1px 7px; ' +
  'border-radius:999px; background:#b91c1c; color:#fff; font-size:10px; letter-spacing:1px;">DRAFT</span>';

function roadmapHtml(course, { modules, completedSet, currentId, certHref = null }) {
  // Count against the modules this course actually has today — progress docs
  // left behind by a deleted lesson must not round anyone up to 100%.
  const completedCount = modules.filter((m) => completedSet.has(m.id)).length;
  const pct = modules.length ? Math.round((completedCount / modules.length) * 100) : 0;
  const isComplete = modules.length > 0 && completedCount === modules.length;

  const stepsHtml = modules.map((m) => {
    const done = completedSet.has(m.id);
    const isCurrent = m.id === currentId && !done;
    const href = `/courses.html?course=${encodeURIComponent(course.slug)}&module=${m.id}`;
    const state = done ? 'is-done' : (isCurrent ? 'is-current' : 'is-todo');
    const marker = done ? '✓' : String(m.id).padStart(2, '0');
    const cta = done ? 'Review' : (isCurrent ? 'Continue →' : 'Open →');
    // `published` is only ever false when the caller asked for drafts (preview).
    const draftChip = m.published === false ? DRAFT_CHIP : '';
    const pillarLine = [m.pillar, m.duration].filter(Boolean).map(escapeHtml).join(' · ');
    return `
      <a class="roadmap-step ${state}" href="${href}">
        <div class="roadmap-step-marker">${marker}</div>
        <div class="roadmap-step-body">
          <div class="roadmap-step-pillar">${pillarLine}</div>
          <div class="roadmap-step-title">${escapeHtml(m.title)}${draftChip}</div>
          <div class="roadmap-step-sub">${escapeHtml(m.subtitle)}</div>
        </div>
        <div class="roadmap-step-cta">${escapeHtml(cta)}</div>
      </a>
    `;
  }).join('');

  const nextId = (() => {
    for (let i = 0; i < modules.length; i++) {
      if (!completedSet.has(modules[i].id)) return modules[i].id;
    }
    // Nothing left to do — "Review course" opens the last module. This has to
    // be its id, not its index: module ids start at 1 in Firestore-authored
    // courses, so an index sent everyone one lesson short of the end.
    return modules.length ? modules[modules.length - 1].id : 0;
  })();

  const primaryCtaText = completedCount === 0
    ? 'Start course →'
    : (completedCount === modules.length ? 'Review course →' : 'Continue where you left off →');

  return `
    <div class="roadmap-container">
      <header class="roadmap-hero">
        <div class="academy-eyebrow">${escapeHtml(course.eyebrow || 'Course Roadmap')}</div>
        <h1>${escapeHtml(course.title)}</h1>
        <p>${escapeHtml(course.subtitle || '')}</p>

        <div class="roadmap-hero-meta">
          <div class="progress-wrap roadmap-progress">
            <div class="progress-label">
              <span>Course Progress</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="roadmap-hero-stats">
            <div><span class="roadmap-stat-val">${completedCount}</span><span class="roadmap-stat-lbl">Done</span></div>
            <div><span class="roadmap-stat-val">${modules.length - completedCount}</span><span class="roadmap-stat-lbl">To go</span></div>
            <div><span class="roadmap-stat-val">${modules.length}</span><span class="roadmap-stat-lbl">Modules</span></div>
          </div>
        </div>

        <div class="roadmap-hero-cta">
          <a class="btn ${isComplete && certHref ? 'btn-ghost' : 'btn-primary'}" href="/courses.html?course=${encodeURIComponent(course.slug)}&module=${nextId}">${escapeHtml(primaryCtaText)}</a>
          ${isComplete && certHref ? `<a class="btn btn-primary" href="${escapeHtml(certHref)}">Get your certificate →</a>` : ''}
        </div>
      </header>

      ${isComplete && certHref ? courseCompleteHtml({ href: certHref, courseTitle: course.title, compact: true }) : ''}

      <section class="roadmap-steps">
        <div class="academy-section-head">
          <h2>Your path</h2>
          <span class="academy-section-meta">${modules.length} steps · self-paced</span>
        </div>
        ${stepsHtml}
      </section>
    </div>
  `;
}

async function renderRoadmap(course, { preview = false } = {}) {
  const slot = $('workspace-roadmap');
  if (!slot) return;
  slot.innerHTML = '<div class="roadmap-container"><p style="color:var(--gray-mid);">Loading roadmap…</p></div>';

  // Modules + progress in one call — course-progress.js knows where each kind
  // of course keeps its completion state.
  const { modules, completed: completedSet } = await loadCourseCompletion(course, { includeDrafts: preview });

  let currentId = 0;
  if (course.slug === '1p-clc') {
    currentId = typeof store.currentModule === 'number' ? store.currentModule : 0;
  } else {
    currentId = modules.length ? modules[0].id : 0;
  }

  if (modules.length === 0) {
    const emptyNote = preview
      ? 'No lessons yet — add one in the course builder and it will show up here, published or not.'
      : 'Course content is being prepared. Check back soon.';
    slot.innerHTML = `
      <div class="roadmap-container">
        <header class="roadmap-hero">
          <div class="academy-eyebrow">${escapeHtml(course.eyebrow || 'Course')}</div>
          <h1>${escapeHtml(course.title)}</h1>
          <p>${escapeHtml(course.subtitle || '')}</p>
          <p style="color:var(--gray-mid);">${escapeHtml(emptyNote)}</p>
        </header>
      </div>
    `;
    return;
  }

  slot.innerHTML = roadmapHtml(course, {
    modules,
    completedSet,
    currentId,
    // Preview pads the roadmap with drafts, so the finished-course state there
    // wouldn't be the one members reach — no certificate offered.
    certHref: preview || course.certificate === false ? null : certificateHref(course.slug)
  });
}

// ─── Workspace swap ───────────────────────────────────────────────────────

const WORKSPACE_SECTIONS = ['workspace-welcome', 'workspace-roadmap', 'workspace-player', 'workspace-coming-soon'];

function showSection(id) {
  WORKSPACE_SECTIONS.forEach((sid) => {
    const el = $(sid);
    if (el) el.hidden = sid !== id;
  });
}

function showWelcome()    { showSection('workspace-welcome'); }
function showRoadmap()    { showSection('workspace-roadmap'); }
function showModule()     { showSection('workspace-player'); }
function showComingSoon() { showSection('workspace-coming-soon'); }

function renderComingSoon(course) {
  const slot = $('workspace-coming-soon');
  if (!slot) return;
  slot.innerHTML = `
    <div class="course-soon-card">
      <div class="academy-eyebrow">${escapeHtml(course.eyebrow || 'Coming Soon')}</div>
      <h2>${escapeHtml(course.title)}</h2>
      <p>${escapeHtml(course.subtitle || '')}</p>
      <p class="course-soon-payment-note">Enrollment opens soon — secure checkout is being set up. Check back shortly to register.</p>
      <div class="course-soon-actions">
        <a class="btn btn-primary" href="/course.html?course=${encodeURIComponent(course.slug)}">View course details →</a>
        <a class="btn btn-ghost" href="/courses.html">← Back to Course Library</a>
      </div>
    </div>
  `;
}

// ─── Owner preview banner ───────────────────────────────────────────────────

function renderPreviewBanner(course) {
  const main = $('courses-main');
  if (!main || $('owner-preview-banner')) return;
  const editLink = course.contentSource === 'firestore'
    ? `<a href="/manage-courses.html?content=${encodeURIComponent(course.slug)}" target="_blank" rel="noopener" style="color:#fff; text-decoration:underline;">✎ Edit content</a>`
    : '';
  const banner = document.createElement('div');
  banner.id = 'owner-preview-banner';
  banner.style.cssText = 'position:sticky; top:0; z-index:50; background:#b91c1c; color:#fff; ' +
    'padding:8px 16px; font-size:13px; display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
  banner.innerHTML =
    `<span>👁 Preview mode (owner) — members see this course as <b>${escapeHtml(course.status || '—')}</b>. ` +
    `Draft lessons are shown here (marked <b>DRAFT</b>) but stay hidden from members until you publish them. ` +
    `This banner is only visible to you.</span>${editLink}` +
    `<a href="#" id="exit-preview" style="color:#fff; text-decoration:underline; margin-left:auto;">Exit preview</a>`;
  main.prepend(banner);
  const exit = $('exit-preview');
  if (exit) exit.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.removeItem('kb_owner_preview');
    location.reload();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (firebaseReady) {
    const user = await onAuthReady();
    if (!user) {
      location.replace('/login.html');
      return;
    }
    if (!(await ensureOnboarded(user))) return;
  }

  // Header first — it carries the Admin/Owner menu and must survive a slow or
  // failed load below.
  renderTopbarEarly({ user: currentUser(), currentPage: null, links: [] });

  // Load courses + progress + enrollments before deciding what to render.
  try { await loadCourses(); } catch (e) {}
  try { await store.load(); } catch (e) {}
  try { await loadEnrollments(); } catch (e) {}
  try { await loadCourseInterests(); } catch (e) {}

  // Owner/admin content preview: a session-scoped flag lets owner/admins view
  // any course (any status, even unenrolled) exactly as members will. Turned on
  // by ?preview=1 and persisted per-tab so roadmap→lesson navigation keeps it.
  let roleInfo = null;
  try { if (firebaseReady && currentUser()) roleInfo = await getRoleInfo(); } catch (e) {}
  const isAdmin = !!(roleInfo && roleInfo.isAdmin);
  if (urlParam('preview') === '1' && isAdmin) sessionStorage.setItem('kb_owner_preview', '1');
  const preview = isAdmin && sessionStorage.getItem('kb_owner_preview') === '1';

  const slug = courseSlug();
  const moduleId = moduleParam();
  const course = slug ? getCourseBySlug(slug, { includeInactive: preview }) : null;

  // Returning from Stripe checkout: the webhook writes the enrollment, which
  // can lag a moment behind the redirect. Poll briefly until it lands.
  if (urlParam('purchase') === 'success' && course && !isEnrolled(course.slug)) {
    for (let i = 0; i < 6 && !isEnrolled(course.slug); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try { await loadEnrollments({ force: true }); } catch (e) {}
    }
  }

  // Always render welcome content + available courses in case we fall back to welcome.
  renderAvailableCourses();

  if (!course) {
    renderSidebar(null);
    showWelcome();
  } else if (course.status !== 'live' && !preview) {
    renderSidebar(null);
    renderComingSoon(course);
    showComingSoon();
  } else if (!isEnrolled(course.slug) && !preview) {
    // User landed on a course they aren't enrolled in — bounce back to welcome
    // and surface it in the Available list.
    renderSidebar(null);
    showWelcome();
  } else if (moduleId != null) {
    // Module view — mount the shared course player at the requested module.
    renderSidebar(course.slug);
    showModule();
    try {
      // A course migrated to the editor (contentSource === 'firestore') always
      // renders via the generic Firestore-backed renderer, even if a code
      // `mount` still exists in the registry — the database is the source of truth.
      // One decision, both render paths: a course opts out of certificates with
      // `certificate: false` on its Firestore doc.
      const certHref = course.certificate === false ? null : certificateHref(course.slug);
      if (course.contentSource !== 'firestore' && typeof course.mount === 'function') {
        await course.mount({ startAt: moduleId, certificateHref: certHref });
      } else {
        // Courses authored in /manage-courses.html render via the generic
        // Firestore-backed renderer. In preview the owner sees drafts too.
        const { mountFirestoreCourse } = await import('./course-renderer.js');
        await mountFirestoreCourse(course, {
          startAt: moduleId,
          includeDrafts: preview,
          certificateHref: certHref
        });
      }
    } catch (e) { console.warn('[courses-page] mount failed', e); }
  } else {
    // Roadmap view — default landing for an enrolled course.
    renderSidebar(course.slug);
    await renderRoadmap(course, { preview });
    showRoadmap();
  }

  // Owner preview banner (only the owner/admin sees this; members never do).
  if (preview && course) renderPreviewBanner(course);

  // Shared header user chip — reuse the role already fetched above.
  const role = roleInfo ? roleInfo.role : null;
  let profile = null;
  try {
    if (firebaseReady && currentUser()) {
      try { profile = await getUserProfile(currentUser().uid); } catch (e) {}
    }
  } catch (e) {}
  // courses.html has its own primary nav (academy-tabs); chip carries
  // only the bell + avatar + sign-out so we don't duplicate the nav.
  renderTopbar({ user: currentUser(), profile, role, currentPage: null, links: [] });
}

main();
