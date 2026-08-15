// Renders the "Academy Courses" grid on the public homepage (index.html) from
// the live course catalog, showing only the courses the owner has switched
// "On main site" in /manage-courses.html (`showOnSite`).
//
// Why this exists: the section used to be three hand-written <div>s, so
// changing what the public sees meant editing HTML and redeploying — and the
// copy had drifted badly from the real catalog (wrong module counts, a course
// that didn't exist). Rendering from courses-data.js means the homepage can't
// go stale, and the owner controls it with a switch.
//
// Two things about index.html make this trickier than it looks:
//
//   1. index.html does NOT load styles.css — all of its CSS is inlined, and
//      its .course-card/.course-thumb classes are a DIFFERENT set from the
//      ones in styles.css that the member library uses. So this file emits the
//      homepage's own markup shape and can't share courses-page.js's card
//      renderer.
//   2. The scroll/tilt animations in index.html run querySelectorAll once, at
//      parse time. Cards injected later are never picked up, and .fade-up
//      starts at opacity:0 — so without re-hooking them the section renders
//      blank. index.html exposes __kbObserveFades (and optionally
//      __kbAttachTilt) for that.

import { loadCourses, getCourses } from './courses-data.js';

// Firebase is already initialised on this page (chatbot.js imports
// firebase.js), so pulling in courses-data.js costs no extra connection.

const GRID_ID = 'home-courses-grid';

// No cap on the number of cards, deliberately: the "On main site" switch is
// meant to be the single control over what the public sees, and a silent
// top-N here would quietly override it. The grid is 3-up on desktop and wraps.

// Alternating thumb backgrounds, matching the hand-written cards this replaces.
// Light-ground cover art, rotated so a grid of coverless courses does not read
// as one flat block. Empty first entry falls through to the CSS default.
const THUMB_BGS = [
  '',
  'linear-gradient(135deg, var(--surface-2) 0%, var(--red-tint) 100%)',
  'linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%)'
];

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Two-letter mark for the card thumbnail, standing in for the cover art the
// catalog doesn't have yet. Picks the most recognisable pair available:
//   "1P Certified Leader Coach" -> 1P   (a leading branded token wins)
//   "Bundle Deal"               -> BD   (multi-word `short`)
//   "Mindset Foundations"       -> MF   (falls through to the title, since
//                                        `short` is the single word "Mindset")
//   "Faith & Leadership"        -> FL   ("&" is not a word)
function words(str) {
  return String(str || '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\w']/g, ''))       // drop "&", ":" etc.
    .filter((w) => w && !/^(the|a|an|of|and|for)$/i.test(w));
}

// Initials of the first two words, or '' when there aren't two — so the caller
// can fall through to a better source rather than settling for "MI".
function pairInitials(str) {
  const w = words(str);
  return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : '';
}

function monogram(course) {
  // A leading token like "1P" is already a mark — keep it intact.
  const lead = words(course.title)[0] || '';
  if (lead.length === 2 && /\d/.test(lead)) return lead.toUpperCase();

  const single = words(course.short)[0] || words(course.title)[0] || course.slug || '1P';
  return pairInitials(course.short)
    || pairInitials(course.title)
    || single.slice(0, 2).toUpperCase();
}

// `eyebrow` is already authored as "Self-paced · 8 Modules" / "Certification ·
// 7 Modules", which maps straight onto the card's two meta lines. Bold the
// leading token of each half the way the static markup did.
function metaLines(course) {
  const parts = String(course.eyebrow || '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  return parts.slice(0, 2).map((part, i) => {
    // "8 Modules" -> "<strong>8</strong> Modules"; otherwise bold the whole
    // fragment ("Self-paced", "Best Value").
    const m = part.match(/^(\S+)\s+(.+)$/);
    const html = m && /^[\d]/.test(m[1])
      ? `<strong>${escapeHtml(m[1])}</strong> ${escapeHtml(m[2])}`
      : `<strong>${escapeHtml(part)}</strong>`;
    return `<div class="course-detail"${i ? ' style="margin-top:4px;"' : ''}>${html}</div>`;
  }).join('');
}

// Only live courses reach this point, so the badge is about what the card is
// rather than whether it's available — a bundle gets called out as the value
// pick, everything else is simply buyable.
function badgeLabel(course) {
  return course.bundleHref ? 'Best Value' : 'Enroll Now';
}

function cardHtml(course, i) {
  const slug = encodeURIComponent(course.slug);
  const delay = i > 0 ? ` fade-up-delay-${Math.min(i, 5)}` : '';
  const bg = THUMB_BGS[i % THUMB_BGS.length];

  // The monogram is always rendered and the cover image sits on top, so a
  // cover URL that 404s degrades to the mark rather than a broken image.
  // Same trick as the admin dashboard cards (manage-courses.js).
  const cover = course.coverImage || course.image;
  const coverImg = cover
    ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.remove()"
            style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover;">`
    : '';

  // Bundles have their own sales page; everything else uses the shared
  // public course landing page.
  const href = course.bundleHref || `/course.html?course=${slug}`;

  return `
      <div class="course-card fade-up${delay}">
        <div class="course-thumb">
          <div class="course-thumb-bg"${bg ? ` style="background: ${bg};"` : ''}></div>
          <div class="course-thumb-num">${escapeHtml(monogram(course))}</div>
          ${coverImg}
          <div class="course-thumb-badge">${escapeHtml(badgeLabel(course))}</div>
        </div>
        <div class="course-body">
          <div class="course-cat">${escapeHtml(course.category || '')}</div>
          <div class="course-title">${escapeHtml(course.title || '')}</div>
          <p class="course-desc">${escapeHtml(course.subtitle || '')}</p>
          <div class="course-meta">
            <div>${metaLines(course)}</div>
            <a href="${escapeHtml(href)}" class="course-arrow" aria-label="View ${escapeHtml(course.title || 'course')}">→</a>
          </div>
        </div>
      </div>`;
}

// Nothing publishable to show. Hide the section outright rather than leaving
// an empty grid or a heading with no content under it.
//
// The in-page links that point at #courses have to go with it, or the nav
// item and the hero button become dead clicks. "Courses" links are hidden;
// the hero's generic "Start Your Journey" CTA is repointed at the Programs
// section, which is the nearest equivalent, rather than disappearing — it's
// the primary call to action on the page.
function hideCoursesSection(section) {
  section.hidden = true;

  document.querySelectorAll('a[href="#courses"]').forEach((a) => {
    if (a.closest('.hero-actions')) {
      a.setAttribute('href', '#impact');
      return;
    }
    // Hide the whole <li> in the desktop nav so the list doesn't keep its gap.
    (a.closest('li') || a).style.display = 'none';
  });
}

export async function init() {
  const grid = document.getElementById(GRID_ID);
  const section = document.getElementById('courses');
  if (!grid || !section) return;

  try {
    await loadCourses();
  } catch (e) {
    // Fail closed: we can't tell which courses are published, and showing an
    // unpublished one on the marketing site is worse than showing none.
    console.warn('[home-courses] catalog load failed; hiding the section', e);
    hideCoursesSection(section);
    return;
  }

  // Only genuinely published courses are advertised. `status` is the publish
  // state set from the builder's Publish menu — 'live' means members can
  // actually enroll and take it; 'coming-soon' and 'inactive' are not public.
  // `showOnSite` is the owner's per-course override on top of that, a
  // default-true opt-out so existing courses needed no backfill.
  const courses = getCourses().filter(
    (c) => c.status === 'live' && c.showOnSite !== false
  );

  if (!courses.length) {
    hideCoursesSection(section);
    return;
  }

  grid.innerHTML = courses.map(cardHtml).join('');
  section.hidden = false;

  // Re-hook the animations for the cards we just injected (see header note).
  if (typeof window.__kbObserveFades === 'function') window.__kbObserveFades(grid);
  if (typeof window.__kbAttachTilt === 'function') window.__kbAttachTilt(grid);
}
