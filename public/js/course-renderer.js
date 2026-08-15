// Generic course workspace renderer — mounts any course whose content lives
// in Firestore (`courses/{slug}/modules/{id}`, authored in /manage-courses.html)
// into the shared Coursera-style player (course-player.js), so admin-authored
// courses look identical to courses that ship their lessons in code.
//
// Progress is namespaced per course: users/{uid}/progress/{slug}__m{id}
// (each course namespaces its progress ids by slug).

import { auth, db, firebaseReady } from './firebase.js';
import {
  doc, setDoc, getDocs, collection, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { loadModuleDocs } from './courses-data.js';
import { mountCoursePlayer, escPlayer } from './course-player.js';
import { lessonVideoHtml } from './video-embed.js';

let _purify = null;
async function getPurify() {
  if (_purify) return _purify;
  const mod = await import('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs');
  _purify = mod.default || mod;
  return _purify;
}

function progressDocId(slug, moduleId) { return `${slug}__m${moduleId}`; }

const LS_PREFIX = 'kb_course_progress_';

function lsGetProgress(slug) {
  try { return new Set(JSON.parse(localStorage.getItem(LS_PREFIX + slug) || '[]')); }
  catch (e) { return new Set(); }
}
function lsSetProgress(slug, set) {
  try { localStorage.setItem(LS_PREFIX + slug, JSON.stringify(Array.from(set))); } catch (e) {}
}

/** Completed module ids for a Firestore-rendered course. */
export async function loadCourseProgress(slug) {
  if (!firebaseReady || !auth || !auth.currentUser) return lsGetProgress(slug);
  try {
    const snap = await getDocs(collection(db, 'users', auth.currentUser.uid, 'progress'));
    const prefix = `${slug}__m`;
    const done = new Set();
    snap.docs.forEach((d) => {
      if (d.id.startsWith(prefix) && d.data().completed) {
        done.add(Number(d.id.slice(prefix.length)));
      }
    });
    lsSetProgress(slug, done);
    return done;
  } catch (e) {
    console.warn('[course-renderer] progress load failed', e);
    return lsGetProgress(slug);
  }
}

async function markComplete(slug, moduleId, completedSet) {
  completedSet.add(moduleId);
  lsSetProgress(slug, completedSet);
  if (firebaseReady && auth && auth.currentUser) {
    try {
      await setDoc(doc(db, 'users', auth.currentUser.uid, 'progress', progressDocId(slug, moduleId)), {
        completed: true,
        completedAt: serverTimestamp(),
        courseSlug: slug,
        moduleId
      }, { merge: true });
    } catch (e) {
      console.warn('[course-renderer] markComplete remote write failed', e);
    }
  }
}

// ─── Workbook + Summary tabs ──────────────────────────────────────────────
// Optional per-module content authored in the course builder. The visual
// style mirrors the I Can't course tabs so every course feels identical.
// Workbook answers autosave to localStorage, namespaced per course.

const esc = escPlayer;

function hasWorkbookContent(m) {
  const w = m && m.workbook;
  return !!(w && (w.reflection || w.action || (Array.isArray(w.prompts) && w.prompts.length)));
}

function wbStorageKey(slug) { return `kb_wb_${slug}`; }

function loadWbAnswers(slug) {
  try { return JSON.parse(localStorage.getItem(wbStorageKey(slug)) || '{}') || {}; }
  catch (e) { return {}; }
}

function saveWbAnswer(slug, key, value) {
  try {
    const all = loadWbAnswers(slug);
    all[key] = value;
    localStorage.setItem(wbStorageKey(slug), JSON.stringify(all));
  } catch (e) {}
}

function emptyTabCard(text) {
  return `<div style="background:#111;border:1px solid #1E1E1E;border-radius:12px;padding:24px;color:#888;font-size:13px;text-align:center;">${esc(text)}</div>`;
}

function workbookTabHtml(slug, m) {
  if (!hasWorkbookContent(m)) return emptyTabCard('This lesson has no workbook.');
  const w = m.workbook;
  const answers = loadWbAnswers(slug);
  const prompts = (w.prompts || []).map((prompt, i) => {
    const key = `m${m.id}_${i}`;
    const val = esc(answers[key] || '');
    return `
      <div>
        <label style="display:block;font-size:12px;color:#AAAAAA;margin-bottom:6px;font-style:italic;">${esc(prompt)}</label>
        <textarea class="fsw-textarea" data-wb-key="${esc(key)}"
          placeholder="Write your answer here..."
          style="width:100%;background:#0D0D0D;border:1px solid #2A2A2A;border-radius:8px;
            color:#fff;padding:10px 12px;font-size:13px;line-height:1.5;
            font-family:inherit;resize:vertical;min-height:80px;
            box-sizing:border-box;">${val}</textarea>
      </div>`;
  }).join('');

  return `
    <div>
      <div style="margin-bottom:20px;">
        <h2 style="font-family:'Audrey',sans-serif;font-size:22px;color:#fff;margin-bottom:6px;letter-spacing:0.5px;">YOUR WORKBOOK</h2>
        <p style="color:#AAAAAA;font-size:13px;margin:0;">Your answers are saved locally. Be honest — no one else sees this.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:20px;">
        ${w.reflection ? `
        <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;">
          <div style="font-size:10px;letter-spacing:2px;color:#C8102E;font-weight:600;margin-bottom:8px;">REFLECTION PROMPT</div>
          <p style="color:#CCC;line-height:1.6;font-size:14px;margin:0;">${esc(w.reflection)}</p>
        </div>` : ''}
        ${(w.action || prompts) ? `
        <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;">
          <div style="font-size:10px;letter-spacing:2px;color:#C8102E;font-weight:600;margin-bottom:8px;">ACTION PROMPT</div>
          ${w.action ? `<p style="color:#CCC;line-height:1.6;font-size:14px;margin-bottom:20px;">${esc(w.action)}</p>` : ''}
          <div style="display:flex;flex-direction:column;gap:14px;">${prompts}</div>
        </div>` : ''}
      </div>
    </div>`;
}

function bindWorkbookTab(slug, root) {
  root.querySelectorAll('.fsw-textarea').forEach((ta) => {
    ta.addEventListener('input', () => saveWbAnswer(slug, ta.dataset.wbKey, ta.value));
  });
}

// Downloadable lesson attachments, shown under the lesson body. Injected
// OUTSIDE the DOMPurify-sanitized block (like the video embed), so it is
// built only from escaped scalar fields.
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return b ? `${b} B` : '';
}

function resourcesHtml(m) {
  const files = Array.isArray(m.attachments) ? m.attachments.filter((a) => a && a.url) : [];
  if (!files.length) return '';
  const rows = files.map((a) => `
    <a href="${esc(a.url)}" target="_blank" rel="noopener" download
       style="display:flex;gap:12px;align-items:center;padding:12px 16px;background:#111;border:1px solid #1E1E1E;border-radius:8px;color:#D0D0D0;text-decoration:none;font-size:13px;">
      <span style="font-size:16px;">📎</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.name || 'Download')}</span>
      <span style="flex:1;"></span>
      <span style="color:#888;font-size:12px;flex-shrink:0;">${esc(fmtSize(a.size))}</span>
      <span style="color:#C8102E;font-size:12px;flex-shrink:0;">Download ↓</span>
    </a>`).join('');
  return `
    <div style="margin-top:28px;">
      <div style="font-size:10px;letter-spacing:2px;color:#C8102E;font-weight:600;margin-bottom:12px;">RESOURCES</div>
      <div style="display:flex;flex-direction:column;gap:10px;">${rows}</div>
    </div>`;
}

function summaryTabHtml(m) {
  const items = Array.isArray(m.summary) ? m.summary : [];
  if (!items.length) return emptyTabCard('This lesson has no summary.');
  const rows = items.map((item, i) => `
    <div style="display:flex;gap:14px;align-items:flex-start;padding:14px 16px;background:#111;border:1px solid #1E1E1E;border-radius:8px;">
      <div style="font-family:'Audrey',sans-serif;font-size:28px;color:#C8102E;line-height:1;flex-shrink:0;width:20px;">${i + 1}</div>
      <p style="color:#D0D0D0;line-height:1.6;font-size:13px;margin:0;">${esc(item)}</p>
    </div>`).join('');
  return `
    <div>
      <div style="font-size:10px;letter-spacing:2px;color:#C8102E;font-weight:600;margin-bottom:14px;">KEY TAKEAWAYS</div>
      <div style="display:flex;flex-direction:column;gap:10px;">${rows}</div>
    </div>`;
}

// ─── Mount ────────────────────────────────────────────────────────────────

export async function mountFirestoreCourse(course, { startAt, includeDrafts = false, certificateHref = null } = {}) {
  const container = document.getElementById('workspace-player');
  // Draft lessons (published === false) are hidden from members by
  // loadModuleDocs. Owner/admin preview passes includeDrafts so the author can
  // see work-in-progress lessons exactly as members eventually will.
  const modules = await loadModuleDocs(course.slug, { includeDrafts });

  if (modules.length === 0) {
    if (container) {
      container.innerHTML = includeDrafts
        ? '<p style="color:var(--gray-mid); padding:24px;">No lessons yet — add one in the course builder and it will show up here, published or not.</p>'
        : '<p style="color:var(--gray-mid); padding:24px;">Course content is being prepared. Check back soon.</p>';
    }
    return;
  }

  const completed = await loadCourseProgress(course.slug);
  const purify = await getPurify();
  const byId = (pm) => modules.find((x) => x.id === pm.id) || {};

  const tabs = [{
    id: 'lesson',
    label: 'Lesson',
    html: (pm) => {
      const m = byId(pm);
      return lessonVideoHtml(m) +
        `<div class="lesson-body">${purify.sanitize(m.html || '', { USE_PROFILES: { html: true } })}</div>` +
        resourcesHtml(m);
    }
  }];
  if (modules.some(hasWorkbookContent)) {
    tabs.push({
      id: 'workbook',
      label: 'Workbook',
      html: (pm) => workbookTabHtml(course.slug, byId(pm)),
      bind: (root) => bindWorkbookTab(course.slug, root)
    });
  }
  if (modules.some((m) => Array.isArray(m.summary) && m.summary.length)) {
    tabs.push({
      id: 'summary',
      label: 'Summary',
      html: (pm) => summaryTabHtml(byId(pm))
    });
  }

  mountCoursePlayer({
    container,
    courseTitle: String(course.short || course.title || '').toUpperCase(),
    modules: modules.map((m) => {
      // In preview, a draft is labelled everywhere it appears so the owner is
      // never left guessing which lessons members can actually reach.
      const draft = includeDrafts && m.published === false;
      return {
        id: m.id,
        title: m.title || `Module ${m.id}`,
        subtitle: m.subtitle || '',
        eyebrow: [m.pillar, draft ? 'Draft — not visible to members' : ''].filter(Boolean).join(' · '),
        duration: m.duration || '',
        meta: [m.duration, m.tagLabel || m.pillar, draft ? 'DRAFT' : ''].filter(Boolean).join(' · ')
      };
    }),
    tabs,
    progress: {
      isComplete: (id) => completed.has(id),
      markComplete: (id) => markComplete(course.slug, id, completed)
    },
    // Drafts are only ever in `modules` during owner preview; finishing a
    // draft-padded module list isn't the same course members will complete, so
    // preview never offers the certificate.
    certificateHref: includeDrafts ? null : certificateHref,
    startAt
  });
}
