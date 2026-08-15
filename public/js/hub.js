// Kailey Brown Academy — hub landing controller.
// Post-login dashboard: greeting, continue-course card, quick-access tiles, community preview.

import { loadCourseCompletion } from './course-progress.js';
import { onAuthReady, currentUser, getMyReferralCode } from './auth.js';
import { getRoleInfo } from './roles.js';
import { firebaseReady } from './firebase.js';
import { renderTopbar, renderTopbarEarly } from './topbar.js';
import { ensureOnboarded } from './onboarding-guard.js';
import {
  getUserProfile,
  hasNewPostsSinceVisit,
  listPosts,
  avatarHtml,
  escapeHtml,
  fmtRelative,
  initials
} from './community.js';
import { loadEnrollments, enrolledCourses, isEnrolled } from './enrollments.js';

const $ = (id) => document.getElementById(id);

function firstName(nameOrEmail) {
  if (!nameOrEmail) return 'there';
  const clean = String(nameOrEmail).split('@')[0].replace(/[._-]+/g, ' ').trim();
  const first = clean.split(' ')[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
}

function renderUserChip(user, role, { profile = null, hasNewCommunity = false } = {}) {
  // index.html has its own primary nav (academy-tabs); the chip should
  // only carry the bell + avatar + sign-out so the two don't duplicate.
  renderTopbar({ user, profile, role, currentPage: 'dashboard', links: [] });
  const badge = $('hub-community-badge');
  if (badge) badge.style.display = hasNewCommunity ? '' : 'none';
}

function renderGreeting(user, profile) {
  const name = firstName((profile && profile.displayName) || (user && user.displayName) || (user && user.email));
  $('hub-greeting').innerHTML = `Welcome back, <span>${escapeHtml(name)}</span>.`;
  renderDailyQuote();
}

// One encouraging line, rotated daily. The index is derived from the local
// calendar date so the quote is stable across reloads within a day and
// advances at midnight — no storage or network needed.
// TODO(brand): swap these for Kailey's own lines when the voice guide is ready.
// Kept deliberately plain so nothing here reads as another brand's slogan.
const DAILY_QUOTES = [
  'Small steps, taken daily, become the distance no one else is willing to travel.',
  'Discipline is the bridge between the person you are and the person you intend to become.',
  'Show up today and let the work compound.',
  'You don’t rise to your goals; you fall to your systems. Build one good habit today.',
  'Potential means nothing until it meets action. Begin where you are.',
  'Consistency outlasts intensity. One honest hour beats a perfect plan never started.',
  'The work you avoid is usually the work that frees you. Lean in.',
  'Progress is quiet. Trust it even on the days it doesn’t feel like winning.',
  'Clarity comes from doing, not waiting. Move, and the path reveals itself.',
  'Your future is built in the unremarkable hours. Make this one count.',
  'Growth lives just past comfort. Take the step that stretches you.',
  'Be relentless about progress, patient about results.',
  'The standard you walk past is the standard you accept. Raise it today.',
  'Energy follows commitment. Decide first, then act.',
  'You are not behind. You are exactly one decision away from forward.',
  'Master the basics until they master you. Excellence is repetition with intention.',
  'Do the hard thing while it is still small. Tomorrow it only grows.',
  'Momentum is a choice you make before you feel like it.',
  'Focus is a superpower in a distracted world. Guard your attention like it matters.',
  'Effort compounds quietly, then all at once. Keep depositing.',
  'Don’t count the days — make the days count.',
  'The person you’re becoming is watching what you do right now.',
  'Plant today what your future self will be grateful to harvest.'
];

function dayIndex() {
  const now = new Date();
  // Days since the Unix epoch in local time → a stable integer per calendar day.
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(startOfDay.getTime() / 86400000);
}

function renderDailyQuote() {
  const el = $('hub-subtitle');
  if (!el) return;
  const quote = DAILY_QUOTES[((dayIndex() % DAILY_QUOTES.length) + DAILY_QUOTES.length) % DAILY_QUOTES.length];
  el.textContent = quote;
  // Re-trigger the entrance animation on each render: drop the class, force a
  // reflow, then re-add so the keyframes restart and draw attention.
  el.classList.remove('hub-quote-enter');
  void el.offsetWidth;
  el.classList.add('hub-quote-enter');
}

// Per-course progress. Every course goes through loadCourseCompletion(), so
// this works the same whether a course was authored in the CMS or in code.
// Results are cached per render pass to avoid refetching the same course for
// the continue card, the module map and the enrolled list.
const _completionCache = new Map();

async function completionFor(course) {
  if (!course) return null;
  if (!_completionCache.has(course.slug)) {
    _completionCache.set(
      course.slug,
      loadCourseCompletion(course).catch(() => null)
    );
  }
  return _completionCache.get(course.slug);
}

function statusLabel(completion) {
  if (!completion || completion.total === 0) return 'Not started';
  if (completion.pct === 0) return 'Not started';
  if (completion.isComplete) return 'Complete';
  return 'In progress';
}

/** First module the member hasn't completed; null when the course is done. */
function nextIncompleteModule(completion) {
  if (!completion) return null;
  return completion.modules.find((m) => !completion.completed.has(m.id)) || null;
}

async function renderContinueCard() {
  const slot = $('hub-continue-slot');
  if (!slot) return;

  const enrolled = enrolledCourses();

  // No enrollments yet — prompt the user to browse the course library.
  if (enrolled.length === 0) {
    slot.innerHTML = `
      <div class="academy-continue">
        <div>
          <div class="academy-continue-meta">Start your journey</div>
          <div class="academy-continue-title">No active courses yet</div>
          <div class="academy-continue-sub">Browse the Academy library and sign up for your first course — the work starts when you choose.</div>
        </div>
        <a class="btn btn-primary btn-cta-pulse" href="/courses.html">Browse courses →</a>
      </div>
    `;
    return;
  }

  // The first enrolled course is the one we surface.
  const primary = enrolled[0];
  const completion = await completionFor(primary);
  const pct = completion ? completion.pct : 0;

  const courseHref = `/courses.html?course=${encodeURIComponent(primary.slug)}`;
  const moduleHref = (m) => `${courseHref}&module=${encodeURIComponent(m.id)}`;

  let meta, title, sub, cta;
  let href = courseHref;

  const next = nextIncompleteModule(completion);

  if (completion && completion.isComplete) {
    meta = 'Course complete';
    title = primary.title;
    sub = 'The lessons stay open. Come back whenever you want to revisit one.';
    cta = 'Open course →';
  } else if (next) {
    const started = completion && completion.done > 0;
    meta = started ? `Up next · ${next.title}` : `Start here · ${next.title}`;
    title = primary.title;
    sub = next.subtitle || (started
      ? 'Pick up where you left off.'
      : 'Your first lesson is ready when you are.');
    cta = started ? 'Resume →' : 'Begin →';
    href = moduleHref(next);
  } else {
    // Enrolled, but the course has no published lessons yet.
    meta = 'Continue your work';
    title = primary.title;
    sub = primary.subtitle || 'Open your course roadmap.';
    cta = 'Open course →';
  }

  slot.innerHTML = `
    <div class="academy-continue">
      <div>
        <div class="academy-continue-meta">${escapeHtml(meta)}</div>
        <div class="academy-continue-title">${escapeHtml(title)}</div>
        <div class="academy-continue-sub">${escapeHtml(sub)}</div>
        <div class="academy-continue-progress">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="academy-continue-progress-label">${pct}%</div>
        </div>
      </div>
      <a class="btn btn-primary" href="${href}">${escapeHtml(cta)}</a>
    </div>
  `;
}

async function renderModuleMap() {
  const section = $('hub-progress');
  const slot = $('hub-module-map');
  if (!section || !slot) return;

  // Map the member's first enrolled course. Hidden when they have no
  // enrollments, or when that course has no published lessons yet.
  const enrolled = enrolledCourses();
  const primary = enrolled[0];
  const completion = await completionFor(primary);

  if (!primary || !completion || completion.total === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const next = nextIncompleteModule(completion);
  const base = `/courses.html?course=${encodeURIComponent(primary.slug)}`;

  const sectionLink = $('hub-progress-link');
  if (sectionLink) sectionLink.href = base;

  slot.innerHTML = completion.modules.map((m, i) => {
    const done = completion.completed.has(m.id);
    const isCurrent = next && m.id === next.id;
    const state = done ? 'is-done' : (isCurrent ? 'is-current' : 'is-todo');
    const marker = done ? '✓' : String(i + 1).padStart(2, '0');
    const href = `${base}&module=${encodeURIComponent(m.id)}`;
    return `
      <a class="hub-mm-cell ${state}" href="${href}" title="${escapeHtml(m.title)}">
        <span class="hub-mm-marker">${marker}</span>
        <span class="hub-mm-body">
          <span class="hub-mm-pillar">${escapeHtml(m.pillarTag || m.pillar || '')}</span>
          <span class="hub-mm-title">${escapeHtml(m.title)}</span>
          <span class="hub-mm-duration">${escapeHtml(m.duration || '')}</span>
        </span>
      </a>
    `;
  }).join('');
}

async function renderEnrolledList() {
  const list = $('hub-courses-list');
  if (!list) return;

  const enrolled = enrolledCourses();
  if (enrolled.length === 0) {
    list.innerHTML = `
      <a class="academy-list-item" href="/courses.html" style="text-decoration:none;">
        <div class="academy-list-avatar">+</div>
        <div class="academy-list-main">
          <div class="academy-list-title">Browse available courses</div>
          <div class="academy-list-sub">You haven't signed up for any courses yet.</div>
        </div>
        <div class="academy-list-meta">Start</div>
      </a>
    `;
    return;
  }

  const rows = await Promise.all(enrolled.map(async (c) => {
    const completion = await completionFor(c);
    const pct = completion ? completion.pct : 0;
    const total = completion ? completion.total : 0;
    const done = completion ? completion.done : 0;
    const href = `/courses.html?course=${encodeURIComponent(c.slug)}`;
    const subParts = [];
    if (total > 0) subParts.push(`${done} of ${total} modules`);
    subParts.push(`${pct}%`);
    const sub = subParts.join(' · ');
    const avatarInitials = (c.short || c.title).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    return `
      <a class="academy-list-item" href="${href}">
        <div class="academy-list-avatar">${escapeHtml(avatarInitials)}</div>
        <div class="academy-list-main">
          <div class="academy-list-title">${escapeHtml(c.title)}</div>
          <div class="academy-list-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="academy-list-meta">${escapeHtml(statusLabel(completion))}</div>
      </a>
    `;
  }));

  list.innerHTML = rows.join('');
}

async function renderCommunityList({ role, companyId }) {
  const list = $('hub-community-list');
  if (!list) return;

  if (!firebaseReady) {
    list.innerHTML = `<div class="academy-empty">Community is offline right now. Check back in a moment.</div>`;
    return;
  }

  try {
    const { posts } = await listPosts({ pageSize: 4, role, companyId });
    if (!posts || posts.length === 0) {
      list.innerHTML = `
        <div class="academy-empty">
          No posts yet. Start the conversation over in the community.
        </div>
      `;
      return;
    }
    list.innerHTML = posts.map((p) => {
      const name = p.authorName || 'Member';
      const avatarUrl = p.authorAvatar || p.authorAvatarUrl || null;
      const avatarInner = avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
        : escapeHtml(initials(name));
      const snippet = (p.text || '').replace(/\s+/g, ' ').slice(0, 110);
      const when = p.createdAt ? fmtRelative(p.createdAt) : '';
      return `
        <a class="academy-list-item" href="/community.html">
          <div class="academy-list-avatar">${avatarInner}</div>
          <div class="academy-list-main">
            <div class="academy-list-title">${escapeHtml(name)}</div>
            <div class="academy-list-sub">${escapeHtml(snippet)}${(p.text || '').length > 110 ? '…' : ''}</div>
          </div>
          <div class="academy-list-meta">${escapeHtml(when)}</div>
        </a>
      `;
    }).join('');
  } catch (e) {
    console.warn('[hub] community list failed', e);
    list.innerHTML = `<div class="academy-empty">Couldn't load community activity.</div>`;
  }
}

// ─── Invite & Earn ────────────────────────────────────────────────────────
// The member's own referral link plus its running totals. Stays hidden until
// the callable answers, so a failure here shows nothing rather than a broken
// card — and it is never awaited by main().
async function renderReferral() {
  const sec = $('hub-referral');
  if (!sec || !firebaseReady || !currentUser()) return;

  let info;
  try {
    info = await getMyReferralCode();
  } catch (e) {
    console.warn('[hub] referral link unavailable', e);
    return;
  }
  if (!info || !info.url) return;

  // Build the link from the origin the member is actually on, so it carries
  // whichever domain they're browsing rather than the server's hardcoded
  // APP_BASE_URL. Falls back to the server's URL if the token is missing.
  const shareUrl = info.token
    ? `${location.origin}/signup.html?invite=${encodeURIComponent(info.token)}`
    : info.url;

  const per = Number(info.pointsPerReferral || 0);
  const joined = Number(info.joined || 0);
  const activated = Number(info.activated || 0);

  $('ref-per').textContent = String(per);
  $('ref-url').value = shareUrl;
  $('ref-joined').textContent = String(joined);
  $('ref-activated').textContent = String(activated);
  $('ref-points').textContent = String(Number(info.pointsEarned || 0));

  // Explain the gap between the two counts rather than leaving people to
  // wonder why an invite they know landed hasn't scored yet.
  const pending = Math.max(0, joined - activated);
  $('ref-note').textContent = pending
    ? `${pending} ${pending === 1 ? 'person has' : 'people have'} signed up but not finished their profile yet — points land once they do.`
    : 'Points are awarded once someone you invited completes their profile.';

  const urlInput = $('ref-url');
  const copyBtn = $('ref-copy');
  copyBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(shareUrl);
      else { urlInput.select(); document.execCommand('copy'); }
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
    } catch (e) { urlInput.select(); }
  });

  // Native share sheet on phones — the primary way this link will actually move.
  if (navigator.share) {
    const shareBtn = $('ref-share');
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: 'Kailey Brown Academy',
          text: 'Join me in Kailey Brown Academy.',
          url: shareUrl
        });
      } catch (e) { /* user dismissed the sheet */ }
    });
  }

  sec.hidden = false;
}

async function main() {
  if (firebaseReady) {
    const user = await onAuthReady();
    if (!user) {
      location.replace('/login.html');
      return;
    }
    if (!(await ensureOnboarded(user))) return;
  }

  // Paint the header before anything that touches the network. Everything below
  // can be slow or fail; the Admin/Owner menu lives up here and must not go with it.
  renderTopbarEarly({ user: currentUser(), currentPage: 'dashboard', links: [] });

  try { await loadEnrollments(); } catch (e) {}

  let role = null;
  let companyId = null;
  let profile = null;
  let hasNewCommunity = false;

  try {
    if (firebaseReady && currentUser()) {
      const info = await getRoleInfo();
      role = info.role;
      companyId = info.companyId || null;
      try { profile = await getUserProfile(currentUser().uid); } catch (e) {}
      try { hasNewCommunity = await hasNewPostsSinceVisit({ role, companyId }); } catch (e) {}
    }
  } catch (e) {}

  renderGreeting(currentUser(), profile);
  // Course cards each resolve their own progress; failures are contained so one
  // slow course cannot hold up the rest of the dashboard.
  renderContinueCard().catch((e) => console.warn('[hub] continue card failed', e));
  renderModuleMap().catch((e) => console.warn('[hub] module map failed', e));
  renderEnrolledList().catch((e) => console.warn('[hub] course list failed', e));
  renderUserChip(currentUser(), role, { profile, hasNewCommunity });
  renderCommunityList({ role, companyId });
  renderReferral(); // not awaited — the rest of the dashboard must not wait on it
}

main();
