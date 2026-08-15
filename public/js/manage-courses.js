// Manage Courses console — owner + company admins.
// Orchestrates the Kajabi-style course dashboard (cover-image cards), the
// per-course builder (course-builder.js), and the coupons manager
// (manage-coupons.js). Auth gating and the owner-claim bootstrap live here.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady, bootstrapOwner } from './auth.js';
import { getRoleInfo, clearRoleCache } from './roles.js';
import { renderTopbar } from './topbar.js';
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { COURSES } from './courses-registry.js';
import { loadCourses, getCourses, priceInfo } from './courses-data.js';
import {
  initBuilder, openBuilder, builderHasUnsavedChanges, builderDiscardChanges, CODE_CONTENT_SLUGS
} from './course-builder.js';
import { initCoupons } from './manage-coupons.js';
import { openAiGeneratorModal } from './course-ai.js';

const $ = (id) => document.getElementById(id);

// Local copy — community.js (the usual export) drags in firebase-storage,
// which this console page doesn't need.
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

function ok(el, msg) { el.innerHTML = `<div class="auth-ok">${msg}</div>`; }
function err(el, e) { el.innerHTML = `<div class="auth-error">${escapeHtml(e && e.message ? e.message : String(e))}</div>`; }

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

let _userEmail = null;
let _openSlug = null;

// ─── View router ────────────────────────────────────────────────────────────

function showView(name) {
  const views = { courses: 'courses-view', builder: 'builder-view', coupons: 'coupons-view' };
  Object.entries(views).forEach(([key, id]) => {
    const el = $(id);
    if (el) el.style.display = key === name ? 'block' : 'none';
  });
  // The builder isn't a real tab — highlight Courses while it's open.
  const activeTab = name === 'coupons' ? 'coupons' : 'courses';
  document.querySelectorAll('.console-tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.view === activeTab));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ─── Dashboard (Kajabi-style course cards) ──────────────────────────────────

const STATUS_OPTS = [
  ['live', 'Live'],
  ['coming-soon', 'Coming soon'],
  ['inactive', 'Inactive'],
  ['bundle', 'Bundle']
];

const STATUS_LABELS = { live: 'Live', 'coming-soon': 'Coming soon', inactive: 'Inactive', bundle: 'Bundle' };

function courseCardHtml(c) {
  const slug = escapeHtml(c.slug);
  const cur = c.status || 'coming-soon';
  const p = priceInfo(c);

  // The text mark is always rendered and the image sits on top of it, so a
  // cover URL that 404s degrades to the mark rather than a broken-image icon.
  const mark = `<div class="mc-card-cover-mark">${escapeHtml(c.short || c.title || c.slug)}</div>`;
  const cover = c.coverImage
    ? `${mark}<img src="${escapeHtml(c.coverImage)}" alt="" loading="lazy" onerror="this.remove()">`
    : mark;

  const price = p.label
    ? `<span class="mc-card-price">${p.onSale ? `<s>${escapeHtml(p.originalLabel)}</s>` : ''}${escapeHtml(p.label)}</span>`
    : `<span class="mc-card-price" style="color:var(--gray-mid); font-weight:400;">No price</span>`;

  const lessons = typeof c.moduleCount === 'number'
    ? `${c.moduleCount} lesson${c.moduleCount === 1 ? '' : 's'}`
    : '';

  const statusSel = `<select class="row-status status-${escapeHtml(cur)}" data-status="${slug}" title="Change status">` +
    STATUS_OPTS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('') +
    `</select>`;

  return `
    <div class="mc-card" data-slug="${slug}">
      <div class="mc-card-cover" data-open="${slug}" title="Open the course builder">
        ${cover}
      </div>
      <div class="mc-card-body">
        <div class="mc-card-title" data-open="${slug}">${escapeHtml(c.title)}</div>
        <span class="mc-pill is-${escapeHtml(cur)} mc-card-status">${escapeHtml(STATUS_LABELS[cur] || cur)}</span>
        <div class="mc-card-slug">${slug}</div>
        <div class="mc-card-meta">
          ${price}
          ${lessons ? `<span>· ${escapeHtml(lessons)}</span>` : ''}
          ${p.isSubscription ? `<span>· ${p.intervalSuffix === '/yr' ? 'yearly' : 'monthly'}</span>` : ''}
        </div>
      </div>
      <div class="mc-card-actions">
        ${statusSel}
        <label class="mc-switch" title="Show this course in the Courses section of the public homepage">
          <input type="checkbox" data-onsite="${slug}"${c.showOnSite !== false ? ' checked' : ''}>
          <span class="mc-switch-track"></span>
          <span>On main site</span>
        </label>
        <button class="btn btn-primary" data-open="${slug}" style="font-size:12px; padding:7px 14px;">Edit</button>
        <button class="btn btn-ghost" data-preview="${slug}" style="font-size:12px; padding:7px 12px;">Preview</button>
        <span style="flex:1;"></span>
        <span class="kebab" data-kebab>
          <button class="kebab-btn" type="button" aria-label="More actions" data-kebab-toggle>⋯</button>
          <span class="kebab-menu">
            <button type="button" data-landing="${slug}">Landing page ↗</button>
            <button type="button" class="kebab-danger" data-del-course="${slug}">Delete</button>
          </span>
        </span>
      </div>
    </div>`;
}

function renderDashboard() {
  const grid = $('courses-grid');
  const courses = getCourses({ includeInactive: true });
  if (courses.length === 0) {
    grid.innerHTML = `<div style="color:var(--gray-mid); grid-column:1/-1; padding:24px 0;">No courses yet — click <b>+ New course</b> to build your first one.</div>`;
    return;
  }
  grid.innerHTML = courses.map(courseCardHtml).join('');

  grid.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', (e) => { e.preventDefault(); openBuilderView(b.dataset.open); }));
  grid.querySelectorAll('[data-preview]').forEach((b) =>
    b.addEventListener('click', () => previewCourse(b.dataset.preview)));
  grid.querySelectorAll('[data-landing]').forEach((b) =>
    b.addEventListener('click', () =>
      window.open(`/course.html?course=${encodeURIComponent(b.dataset.landing)}`, '_blank', 'noopener')));
  grid.querySelectorAll('[data-del-course]').forEach((b) =>
    b.addEventListener('click', () => deleteCourse(b.dataset.delCourse)));
  grid.querySelectorAll('[data-status]').forEach((sel) =>
    sel.addEventListener('change', () => setCourseStatus(sel.dataset.status, sel.value)));
  grid.querySelectorAll('[data-onsite]').forEach((cb) =>
    cb.addEventListener('change', () => setCourseOnSite(cb.dataset.onsite, cb.checked, cb)));
  grid.querySelectorAll('[data-kebab-toggle]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = b.closest('[data-kebab]');
      const wasOpen = menu.classList.contains('open');
      closeKebabs();
      if (!wasOpen) menu.classList.add('open');
    }));
}

async function refreshCourses() {
  await loadCourses({ force: true });
  renderDashboard();
}

// Close any open kebab menu (also wired to a document click in main()).
function closeKebabs() {
  document.querySelectorAll('[data-kebab].open').forEach((m) => m.classList.remove('open'));
}

// Owner-only hard delete of a course doc. Leaves the modules subcollection
// orphaned (Firestore can't cascade client-side); gated behind a confirm.
async function deleteCourse(slug) {
  if (!slug) return;
  const c = getCourses({ includeInactive: true }).find((x) => x.slug === slug);
  if (!confirm(`Delete "${c ? c.title : slug}"? This removes the course. This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'courses', slug));
    if (_openSlug === slug) { _openSlug = null; showView('courses'); }
    await refreshCourses();
  } catch (e) {
    alert(`Could not delete course: ${e && e.message ? e.message : e}`);
  }
}

// Quick status flip from a dashboard card.
async function setCourseStatus(slug, status) {
  if (!slug) return;
  try {
    await setDoc(doc(db, 'courses', slug), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    await refreshCourses();
  } catch (e) {
    alert(`Could not update status: ${e && e.message ? e.message : e}`);
  }
}

// Quick "show on the public homepage" flip from a dashboard card.
//
// Deliberately separate from `status`: 'inactive' hides a course everywhere
// (including the member library), whereas this only controls whether the
// course is advertised on the marketing site. A course can be live for
// members while staying off the public homepage, and vice versa.
//
// The field is a default-true opt-out (`showOnSite !== false`), matching the
// `published` / `certificate` convention used elsewhere, so the courses that
// already exist stay visible without a backfill.
//
// No full re-render here — the switch is its own indicator and rebuilding the
// grid mid-click makes the toggle feel like it bounced. We still force-reload
// the merged cache so the builder's Settings tab agrees with the dashboard.
async function setCourseOnSite(slug, on, cb) {
  if (!slug) return;
  try {
    await setDoc(doc(db, 'courses', slug), {
      showOnSite: on,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    await loadCourses({ force: true });
  } catch (e) {
    if (cb) cb.checked = !on; // put the switch back where it was
    alert(`Could not update site visibility: ${e && e.message ? e.message : e}`);
  }
}

// Open the member course page in owner preview mode (bypasses status/enrollment
// gates for admins — see courses-page.js). New tab so the builder stays put.
function previewCourse(slug) {
  if (!slug) return;
  window.open(`courses.html?course=${encodeURIComponent(slug)}&preview=1`, '_blank', 'noopener');
}

// ─── New course modal ───────────────────────────────────────────────────────

function openNewCourseModal() {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal card">
        <h3 style="margin:0 0 14px;">New course</h3>
        <div class="crm-form">
          <div class="crm-form-row">
            <label for="nc-title">Course title</label>
            <input id="nc-title" type="text" placeholder="e.g. Mindset Foundations" autocomplete="off">
          </div>
          <div class="crm-form-row">
            <label for="nc-slug">URL slug</label>
            <input id="nc-slug" type="text" placeholder="auto from title" pattern="[a-z0-9-]+" autocomplete="off">
            <div class="mc-field-note" id="nc-slug-note">Course page will be /course.html?course=<b id="nc-slug-preview">…</b></div>
          </div>
          <div id="nc-result"></div>
          <div class="crm-modal-actions">
            <button class="btn btn-ghost" type="button" id="nc-cancel">Cancel</button>
            <button class="btn btn-primary" type="button" id="nc-create">Create course</button>
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; };
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });
  $('nc-cancel').addEventListener('click', close);

  const titleEl = $('nc-title');
  const slugEl = $('nc-slug');
  const updateSlugPreview = () => {
    const s = slugify(slugEl.value.trim() || titleEl.value.trim()) || '…';
    $('nc-slug-preview').textContent = s;
  };
  titleEl.addEventListener('input', updateSlugPreview);
  slugEl.addEventListener('input', updateSlugPreview);
  titleEl.focus();

  $('nc-create').addEventListener('click', async () => {
    const out = $('nc-result');
    try {
      const title = titleEl.value.trim();
      if (!title) throw new Error('Title is required.');
      const slug = slugify(slugEl.value.trim() || title);
      if (!slug) throw new Error('Could not derive a slug — set one explicitly.');
      if (getCourses({ includeInactive: true }).some((c) => c.slug === slug)) {
        throw new Error(`A course with the slug "${slug}" already exists.`);
      }
      const btn = $('nc-create');
      btn.disabled = true;
      btn.textContent = 'Creating…';
      await setDoc(doc(db, 'courses', slug), {
        slug,
        title,
        status: 'coming-soon',
        showOnSite: true,
        contentSource: 'firestore',
        moduleCount: 0,
        priceLabel: null,
        pricing: { mode: 'one-time', interval: null },
        sortOrder: getCourses({ includeInactive: true }).length,
        updatedAt: serverTimestamp(),
        updatedBy: _userEmail
      }, { merge: true });
      await refreshCourses();
      close();
      openBuilderView(slug);
    } catch (e) {
      err(out, e);
      const btn = $('nc-create');
      if (btn) { btn.disabled = false; btn.textContent = 'Create course'; }
    }
  });
}

// ─── Builder open/close ─────────────────────────────────────────────────────

async function openBuilderView(slug) {
  _openSlug = slug;
  showView('builder');
  await openBuilder(slug);
}

function backToDashboard() {
  if (builderHasUnsavedChanges() && !confirm('You have unsaved lesson changes. Leave anyway?')) return;
  builderDiscardChanges();
  _openSlug = null;
  showView('courses');
  refreshCourses();
}

// ─── Seeding ────────────────────────────────────────────────────────────────

async function seedDefaults() {
  const out = $('seed-result');
  out.innerHTML = '<div style="color:var(--gray-light); font-size:12px;">Seeding…</div>';
  try {
    let wrote = 0;
    for (const c of COURSES) {
      const ref = doc(db, 'courses', c.slug);
      const snap = await getDoc(ref);
      if (snap.exists()) continue;
      await setDoc(ref, {
        slug: c.slug,
        title: c.title,
        short: c.short || null,
        subtitle: c.subtitle || null,
        eyebrow: c.eyebrow || null,
        category: c.category || null,
        status: c.status,
        price: typeof c.price === 'number' ? c.price : null,
        priceNote: c.priceNote || null,
        bundleHref: c.bundleHref || null,
        salePrice: null,
        pricing: { mode: 'one-time', interval: null },
        contentSource: CODE_CONTENT_SLUGS.has(c.slug) ? 'code' : 'firestore',
        sortOrder: COURSES.indexOf(c),
        updatedAt: serverTimestamp(),
        updatedBy: _userEmail
      });
      wrote++;
    }
    ok(out, wrote ? `Seeded ${wrote} course${wrote === 1 ? '' : 's'}.` : 'All built-in courses are already in the database.');
    await refreshCourses();
  } catch (e) { err(out, e); }
}

// ─── One-time content migrations ───────────────────────────────────────────
// Maps a course slug to a routine that copies lessons shipped in JS into
// editable courses/{slug}/modules docs. Empty because no course ships lessons
// in code; add an entry here only if one ever does.
const MIGRATABLE = {};

// Banner-triggered migration from inside the builder: migrate, then reopen the
// builder so the curriculum is immediately editable.
async function migrateCourseLessons(slug) {
  const mig = MIGRATABLE[slug];
  if (!mig) return;
  if (!confirm(`Copy ${mig.label}'s built-in lessons into the course builder? The course switches to render from the database and every lesson becomes editable here. Members see the same course; their progress tracking starts fresh. Safe to re-run.`)) return;
  try {
    await mig.run();
    await refreshCourses();
    await openBuilderView(slug);
  } catch (e) {
    alert(`Migration failed: ${e && e.message ? e.message : e}`);
  }
}

async function migrateIcant() {
  const out = $('seed-result');
  if (!confirm('Migrate "I Can’t: The Course" into the course builder? This copies its 8 lessons into the database (workbook + summary become editable tabs) and switches the live course to render from there. You can re-run it safely.')) return;
  showView('courses');
  out.innerHTML = '<div style="color:var(--gray-light); font-size:12px;">Migrating "I Can’t"…</div>';
  try {
    const wrote = await migrateIcantCore();
    ok(out, `Migrated ${wrote} lessons. "I Can’t: The Course" is now fully editable in the builder — including its Workbook and Summary tabs.`);
    await refreshCourses();
  } catch (e) { err(out, e); }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!firebaseReady) { gate('Firebase is unavailable.'); return; }
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/manage-courses.html')); return; }
  _userEmail = u.email || u.uid;

  let info = await getRoleInfo(true);

  // The owner account may have role 'owner' in its Firestore user doc but lack the
  // `role=owner` custom claim that Firestore rules require for course writes. Without
  // the claim, this page would load but every Save/Publish would be permission-denied.
  // Auto-run the (email-validated, server-side) bootstrapOwner claim once, refresh the
  // token, and re-read role info so writes succeed. Failures never block the page.
  if (info.role === 'owner') {
    try {
      const tok = await u.getIdTokenResult();
      if (!tok.claims || tok.claims.role !== 'owner') {
        await bootstrapOwner();
        await u.getIdToken(true);
        clearRoleCache();
        info = await getRoleInfo(true);
      }
    } catch (e) { console.warn('[manage-courses] owner claim bootstrap skipped', e); }
  }

  renderTopbar({ user: u, role: info.role, currentPage: null });
  if (!info.isAdmin) {
    gate(`You are signed in as <b>${escapeHtml(u.email || '')}</b> but this page requires an admin or owner account.`);
    return;
  }
  $('panel').style.display = 'block';

  // Top-level tabs + builder back link.
  document.querySelectorAll('.console-tab').forEach((t) =>
    t.addEventListener('click', () => {
      if ($('builder-view').style.display !== 'none' && builderHasUnsavedChanges()
        && !confirm('You have unsaved lesson changes. Leave anyway?')) return;
      builderDiscardChanges();
      showView(t.dataset.view);
    }));
  $('btn-builder-back').addEventListener('click', (e) => { e.preventDefault(); backToDashboard(); });
  // Close kebab menus on any outside click.
  document.addEventListener('click', closeKebabs);

  $('btn-seed').addEventListener('click', seedDefaults);
  $('btn-migrate-icant').addEventListener('click', migrateIcant);
  $('btn-add-course').addEventListener('click', openNewCourseModal);
  $('btn-ai-course').addEventListener('click', () => openAiGeneratorModal({
    userEmail: _userEmail,
    onDone: async (slug) => {
      await refreshCourses();
      await openBuilderView(slug);
    }
  }));

  initBuilder({
    userEmail: _userEmail,
    onCoursesChanged: renderDashboard,
    onDeleteCourse: deleteCourse,
    onMigrate: migrateCourseLessons
  });
  initCoupons({ userEmail: _userEmail });

  await refreshCourses();

  // Deep links: ?course=<slug> (primary) and ?content=<slug> (legacy alias,
  // linked from courses-page.js) open that course's builder; ?view=coupons
  // opens the coupons tab. Default view is the course dashboard.
  const params = new URLSearchParams(location.search);
  const deepSlug = params.get('course') || params.get('content');
  if (deepSlug && getCourses({ includeInactive: true }).some((c) => c.slug === deepSlug)) {
    await openBuilderView(deepSlug);
  } else if (params.get('view') === 'coupons') {
    showView('coupons');
  } else {
    showView('courses');
  }
}

main();
