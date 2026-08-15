// Course builder — the per-course workspace on /manage-courses.html.
// Kajabi-style tabbed builder (Curriculum / Sales page / Pricing / Settings)
// with a Skool-style curriculum screen: draggable lesson rail on the left,
// lesson editor on the right.
//
// Data contract (backward compatible — see course-renderer.js):
//   courses/{slug}                 — details, pricing, status, sales-page copy
//   courses/{slug}/modules/{id}    — id, title, subtitle, pillar, duration,
//     tagLabel, html, sortOrder (+ new optional: videoUrl, workbook, summary,
//     published). All writes are setDoc(..., { merge: true }).

import { db } from './firebase.js';
import {
  collection, doc, getDocs, setDoc, deleteDoc, deleteField, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { COURSES } from './courses-registry.js';
import { loadCourses, getCourses } from './courses-data.js';
import { parseVideoUrl, videoEmbedHtml, videoFileHtml, providerLabel } from './video-embed.js';
import { uploadCourseFile, deleteCourseFile, formatBytes } from './course-uploads.js';

const $ = (id) => document.getElementById(id);

// Slugs whose lesson content is rendered from code rather than Firestore.
// Empty: every course is authored through the CMS. Add a slug here only if its
// lessons ship in a JS module, so the builder knows not to treat it as editable.
export const CODE_CONTENT_SLUGS = new Set();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ok(el, msg) { el.innerHTML = `<div class="auth-ok">${msg}</div>`; }
function err(el, e) { el.innerHTML = `<div class="auth-error">${escapeHtml(e && e.message ? e.message : String(e))}</div>`; }

const splitLines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
const splitParagraphs = (v) => String(v || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

// ─── State ──────────────────────────────────────────────────────────────────

const S = {
  slug: null,
  course: null,
  modules: [],
  activeId: null,
  dirty: false,
  salesDirty: new Set(),
  quill: null,
  suppress: false,   // true while programmatically filling fields
  previewOn: false,
  htmlWasOpen: false,
  attachments: [],   // working copy of the open lesson's attachments
  videoFile: null    // working copy of the open lesson's uploaded video
};

let cfg = {};        // { userEmail, onCoursesChanged, onDeleteCourse, onMigrateIcant }
let _userEmail = null;

function findCourse(slug) {
  return getCourses({ includeInactive: true }).find((x) => x.slug === slug) || null;
}

function isCodeContent(c) {
  return !!c && c.contentSource !== 'firestore' && CODE_CONTENT_SLUGS.has(c.slug);
}

// ─── Dirty tracking ─────────────────────────────────────────────────────────

function markDirty() {
  if (S.suppress) return;
  S.dirty = true;
  $('mc-dirty').classList.add('on');
}

function clearDirty() {
  S.dirty = false;
  $('mc-dirty').classList.remove('on');
}

function confirmDiscard() {
  return !S.dirty || confirm('Discard unsaved changes to this lesson?');
}

// ─── Builder header ─────────────────────────────────────────────────────────

const STATUS_LABELS = { live: 'Live', 'coming-soon': 'Coming soon', inactive: 'Inactive', bundle: 'Bundle' };

function renderStatusPill(status) {
  const pill = $('builder-status-pill');
  if (!pill) return;
  const st = status || 'coming-soon';
  pill.textContent = STATUS_LABELS[st] || st;
  pill.className = `mc-pill is-${st}`;
  pill.style.display = '';
}

async function builderSetStatus(status) {
  if (!S.slug) return;
  const out = $('publish-result');
  try {
    await setDoc(doc(db, 'courses', S.slug), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    renderStatusPill(status);
    ok(out, `Status set to <b>${escapeHtml(STATUS_LABELS[status] || status)}</b>.`);
    await reloadCourse();
  } catch (e) { err(out, e); }
}

// Reload the merged course cache after a course-level write and let the
// dashboard re-render behind the builder.
async function reloadCourse() {
  try { await loadCourses({ force: true }); } catch (e) {}
  S.course = findCourse(S.slug) || S.course;
  if (cfg.onCoursesChanged) { try { cfg.onCoursesChanged(); } catch (e) {} }
}

// ─── Builder tabs ───────────────────────────────────────────────────────────

function selectBtab(name) {
  document.querySelectorAll('.mc-btab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.btab === name));
  document.querySelectorAll('.mc-tabpanel').forEach((p) =>
    p.classList.toggle('is-active', p.id === `btab-${name}`));
}

// ─── Curriculum: lesson rail ────────────────────────────────────────────────

let _dragId = null;

function railItemHtml(m, i) {
  const isActive = m.id === S.activeId;
  const draft = m.published === false;
  return `
    <div class="mc-rail-item ${isActive ? 'is-active' : ''}" draggable="true" data-mod-id="${m.id}">
      <span class="mc-rail-handle" title="Drag to reorder">≡</span>
      <span class="mc-rail-num">${i + 1}</span>
      <span class="mc-rail-text">
        <span class="mc-rail-title">${escapeHtml(m.title || `Lesson ${m.id}`)}</span>
        <span class="mc-rail-sub">${escapeHtml([m.duration, (m.videoUrl || m.videoFile) ? '▶ video' : ''].filter(Boolean).join(' · '))}</span>
      </span>
      ${draft ? '<span class="mc-draft-pill">Draft</span>' : ''}
      <span class="mc-rail-arrows">
        <button class="mc-rail-arrow" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="mc-rail-arrow" data-down="${i}" ${i === S.modules.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </span>
    </div>`;
}

function renderRail() {
  const list = $('mc-rail-list');
  const count = $('mc-rail-count');
  if (count) count.textContent = S.modules.length ? `${S.modules.length}` : '';
  if (!S.modules.length) {
    list.innerHTML = '<div class="mc-rail-empty">No lessons yet.</div>';
    return;
  }
  list.innerHTML = S.modules.map((m, i) => railItemHtml(m, i)).join('');

  list.querySelectorAll('.mc-rail-item').forEach((el) => {
    const id = Number(el.dataset.modId);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.mc-rail-arrow')) return;
      if (id !== S.activeId) selectModule(id);
    });

    // ── HTML5 drag reorder (same pattern as the CRM kanban) ──
    el.addEventListener('dragstart', (e) => {
      _dragId = id;
      el.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(id)); } catch (err2) {}
    });
    el.addEventListener('dragend', () => {
      _dragId = null;
      list.querySelectorAll('.mc-rail-item').forEach((x) =>
        x.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (_dragId == null || _dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      el.classList.toggle('is-drop-before', before);
      el.classList.toggle('is-drop-after', !before);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('is-drop-before', 'is-drop-after');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = el.classList.contains('is-drop-before');
      el.classList.remove('is-drop-before', 'is-drop-after');
      if (_dragId == null || _dragId === id) return;
      const fromIdx = S.modules.findIndex((m) => m.id === _dragId);
      let toIdx = S.modules.findIndex((m) => m.id === id);
      if (fromIdx < 0 || toIdx < 0) return;
      if (!before) toIdx += 1;
      if (fromIdx < toIdx) toIdx -= 1;
      if (fromIdx === toIdx) return;
      const [moved] = S.modules.splice(fromIdx, 1);
      S.modules.splice(toIdx, 0, moved);
      renderRail();
      persistOrder();
    });
  });

  list.querySelectorAll('[data-up]').forEach((b) =>
    b.addEventListener('click', () => nudgeModule(Number(b.dataset.up), -1)));
  list.querySelectorAll('[data-down]').forEach((b) =>
    b.addEventListener('click', () => nudgeModule(Number(b.dataset.down), 1)));
}

function nudgeModule(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= S.modules.length) return;
  const [moved] = S.modules.splice(idx, 1);
  S.modules.splice(to, 0, moved);
  renderRail();
  persistOrder();
}

// Renumber every lesson 1..N on drop — self-heals legacy docs with missing
// or duplicate sortOrder values.
async function persistOrder() {
  try {
    await Promise.all(S.modules.map((m, i) => {
      m.sortOrder = i + 1;
      return setDoc(doc(db, 'courses', S.slug, 'modules', String(m.id)), {
        sortOrder: i + 1,
        updatedAt: serverTimestamp(),
        updatedBy: _userEmail
      }, { merge: true });
    }));
  } catch (e) {
    alert(`Could not save the new order: ${e && e.message ? e.message : e}`);
    await refreshModules();
  }
}

async function refreshModules() {
  try {
    const snap = await getDocs(collection(db, 'courses', S.slug, 'modules'));
    S.modules = snap.docs
      .map((d) => ({ id: Number(d.id), ...d.data() }))
      .sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
  } catch (e) {
    $('mc-rail-list').innerHTML = `<div class="mc-rail-empty">${escapeHtml(e.message || String(e))}</div>`;
    S.modules = [];
    return;
  }
  renderRail();
}

async function syncModuleCount() {
  try {
    const snap = await getDocs(collection(db, 'courses', S.slug, 'modules'));
    await setDoc(doc(db, 'courses', S.slug), {
      moduleCount: snap.size,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
  } catch (e) { console.warn('[course-builder] moduleCount sync failed', e); }
}

// ─── Curriculum: lesson editor ──────────────────────────────────────────────

function ensureQuill() {
  if (S.quill) return S.quill;
  // Quill is loaded globally from the CDN <script> tag in manage-courses.html.
  // Constructed lazily while the Curriculum panel is visible — Quill can't
  // measure its container inside display:none.
  S.quill = new window.Quill('#m-quill', {
    theme: 'snow',
    modules: {
      toolbar: [
        [{ header: [2, 3, false] }],
        ['bold', 'italic', 'underline'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'link', 'image'],
        ['clean']
      ]
    }
  });
  S.quill.on('text-change', () => markDirty());
  // Replace Quill's default image behavior (inlines base64 into the doc,
  // bloating it toward Firestore's 1MB limit) with a Storage upload.
  S.quill.getModule('toolbar').addHandler('image', quillImageHandler);
  return S.quill;
}

let _imgInput = null;
function quillImageHandler() {
  if (!_imgInput) {
    _imgInput = document.createElement('input');
    _imgInput.type = 'file';
    _imgInput.accept = 'image/*';
    _imgInput.style.display = 'none';
    document.body.appendChild(_imgInput);
    _imgInput.addEventListener('change', async () => {
      const file = _imgInput.files && _imgInput.files[0];
      _imgInput.value = '';
      if (!file || !S.slug) return;
      const out = $('module-editor-result');
      const q = ensureQuill();
      const range = q.getSelection(true);
      try {
        out.innerHTML = '<span style="color:var(--gray-light);">Uploading image…</span>';
        const meta = await uploadCourseFile(S.slug, 'images', file, (pct) => {
          out.innerHTML = `<span style="color:var(--gray-light);">Uploading image… ${pct}%</span>`;
        });
        q.insertEmbed(range.index, 'image', meta.url, 'user');
        q.setSelection(range.index + 1);
        out.innerHTML = '';
        markDirty();
      } catch (e) { err(out, e); }
    });
  }
  _imgInput.click();
}

function quillHtml() {
  const src = $('m-html');
  if (src.style.display !== 'none') return src.value;
  const q = ensureQuill();
  return typeof q.getSemanticHTML === 'function' ? q.getSemanticHTML() : q.root.innerHTML;
}

function updateVideoHint() {
  const raw = $('m-video').value.trim();
  const hint = $('m-video-hint');
  if (S.videoFile) {
    hint.textContent = 'An uploaded video is set — it takes precedence. Remove it to use a link instead.';
    hint.className = 'mc-video-hint';
    return;
  }
  if (!raw) { hint.textContent = ''; hint.className = 'mc-video-hint'; return; }
  const label = providerLabel(raw);
  if (label) {
    hint.textContent = `✓ ${label} video — it will play above the lesson text.`;
    hint.className = 'mc-video-hint ok';
  } else {
    hint.textContent = 'Unrecognized URL — paste a YouTube, Vimeo, or Loom watch link (not embed code).';
    hint.className = 'mc-video-hint err';
  }
}

// ─── Uploaded lesson video ──────────────────────────────────────────────────

function renderVideoFileInfo() {
  const info = $('m-video-file-info');
  const urlInput = $('m-video');
  if (S.videoFile) {
    info.innerHTML =
      `▶ ${escapeHtml(S.videoFile.name)} (${formatBytes(S.videoFile.size)}) ` +
      `<button class="mc-reset-field" type="button" data-video-remove>remove</button>`;
    info.querySelector('[data-video-remove]').addEventListener('click', () => {
      const removed = S.videoFile;
      S.videoFile = null;
      // Only clean up Storage for files never saved to the lesson — a saved
      // file may still be referenced until the admin hits Save.
      const saved = activeModule();
      if (removed && (!saved || !saved.videoFile || saved.videoFile.path !== removed.path)) {
        deleteCourseFile(removed.path);
      }
      urlInput.disabled = false;
      renderVideoFileInfo();
      updateVideoHint();
      markDirty();
    });
    urlInput.disabled = true;
  } else {
    info.textContent = '';
    urlInput.disabled = false;
  }
}

async function onVideoFilePicked() {
  const input = $('m-video-file');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !S.slug) return;
  const info = $('m-video-file-info');
  const btn = $('btn-video-upload');
  btn.disabled = true;
  try {
    info.textContent = 'Uploading… 0%';
    const meta = await uploadCourseFile(S.slug, 'videos', file, (pct) => {
      info.textContent = `Uploading… ${pct}%`;
    });
    S.videoFile = meta;
    renderVideoFileInfo();
    updateVideoHint();
    markDirty();
  } catch (e) {
    info.innerHTML = `<span style="color:var(--red, #ff7070);">${escapeHtml(e && e.message ? e.message : String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ─── Lesson attachments ─────────────────────────────────────────────────────

function renderAttachList() {
  const list = $('m-attach-list');
  if (!S.attachments.length) {
    list.innerHTML = '<div style="font-size:12px; color:var(--gray-mid);">No files attached yet.</div>';
    return;
  }
  list.innerHTML = S.attachments.map((a, i) => `
    <div style="display:flex; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06); font-size:13px;">
      <span>📎</span>
      <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="color:var(--white-dim); text-decoration:underline; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(a.name)}</a>
      <span style="color:var(--gray-mid); font-size:12px;">${formatBytes(a.size)}</span>
      <span style="flex:1;"></span>
      <button class="mc-reset-field" type="button" data-attach-remove="${i}">remove</button>
    </div>`).join('');
  list.querySelectorAll('[data-attach-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      const [removed] = S.attachments.splice(Number(b.dataset.attachRemove), 1);
      // Same policy as video: only delete from Storage if never saved.
      const saved = activeModule();
      const savedPaths = new Set(((saved && saved.attachments) || []).map((x) => x.path));
      if (removed && !savedPaths.has(removed.path)) deleteCourseFile(removed.path);
      renderAttachList();
      markDirty();
    }));
}

async function onAttachFilesPicked() {
  const input = $('m-attach-file');
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length || !S.slug) return;
  const status = $('m-attach-status');
  const btn = $('btn-attach-upload');
  btn.disabled = true;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      status.textContent = `Uploading ${f.name}… 0%`;
      const meta = await uploadCourseFile(S.slug, 'attachments', f, (pct) => {
        status.textContent = `Uploading ${f.name}… ${pct}%`;
      });
      S.attachments.push(meta);
      renderAttachList();
      markDirty();
      status.textContent = '';
    } catch (e) {
      status.innerHTML = `<span style="color:var(--red, #ff7070);">${escapeHtml(e && e.message ? e.message : String(e))}</span>`;
    }
  }
  btn.disabled = false;
}

function activeModule() { return S.modules.find((m) => m.id === S.activeId) || null; }

function showEditorEmpty(show) {
  $('mc-editor-empty').style.display = show ? '' : 'none';
  $('mc-editor-form').style.display = show ? 'none' : '';
}

function selectModule(id, { force = false } = {}) {
  if (!force && !confirmDiscard()) return;
  const m = S.modules.find((x) => x.id === id);
  if (!m) { S.activeId = null; showEditorEmpty(true); renderRail(); return; }
  S.activeId = m.id;
  S.suppress = true;

  showEditorEmpty(false);
  $('m-title').value = m.title || '';
  $('m-subtitle').value = m.subtitle || '';
  $('m-video').value = m.videoUrl || '';
  $('m-pillar').value = m.pillar || '';
  $('m-duration').value = m.duration || '';
  $('m-taglabel').value = m.tagLabel || '';

  const wb = m.workbook || {};
  $('m-wb-reflection').value = wb.reflection || '';
  $('m-wb-action').value = wb.action || '';
  $('m-wb-prompts').value = (wb.prompts || []).join('\n');
  $('mc-workbook').open = !!(wb.reflection || wb.action || (wb.prompts || []).length);

  const summary = Array.isArray(m.summary) ? m.summary : [];
  $('m-summary').value = summary.join('\n');
  $('mc-summary').open = summary.length > 0;

  S.videoFile = m.videoFile || null;
  renderVideoFileInfo();

  S.attachments = Array.isArray(m.attachments) ? m.attachments.map((a) => ({ ...a })) : [];
  $('mc-attachments').open = S.attachments.length > 0;
  renderAttachList();
  $('m-attach-status').textContent = '';

  const published = m.published !== false;
  $('m-published').checked = published;
  $('m-published-label').textContent = published ? 'Published' : 'Draft';

  const q = ensureQuill();
  const html = m.html || '';
  q.setContents([]);
  if (html) q.clipboard.dangerouslyPasteHTML(html);
  const src = $('m-html');
  src.style.display = 'none';
  src.value = html;
  $('m-quill').parentElement.style.display = 'block';
  $('btn-html-toggle').textContent = 'Edit HTML source';
  resetPreview();
  updateVideoHint();
  $('module-editor-result').innerHTML = '';

  S.suppress = false;
  clearDirty();
  renderRail();
}

function buildWorkbook() {
  const reflection = $('m-wb-reflection').value.trim();
  const action = $('m-wb-action').value.trim();
  const prompts = splitLines($('m-wb-prompts').value);
  if (!reflection && !action && !prompts.length) return null;
  return {
    reflection: reflection || null,
    action: action || null,
    prompts
  };
}

async function saveModule() {
  const out = $('module-editor-result');
  const m = activeModule();
  if (!m) return;
  try {
    const title = $('m-title').value.trim();
    if (!title) throw new Error('Lesson title is required.');
    const rawVideo = S.videoFile ? '' : $('m-video').value.trim();
    if (rawVideo && !parseVideoUrl(rawVideo)) {
      throw new Error('Video URL not recognized — use a YouTube, Vimeo, or Loom link, or clear the field.');
    }
    const btn = $('btn-module-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const summary = splitLines($('m-summary').value);
    const payload = {
      id: m.id,
      title,
      subtitle: $('m-subtitle').value.trim() || null,
      pillar: $('m-pillar').value.trim() || null,
      duration: $('m-duration').value.trim() || null,
      tagLabel: $('m-taglabel').value.trim() || null,
      html: quillHtml(),
      videoUrl: rawVideo || null,
      videoFile: S.videoFile || null,
      attachments: S.attachments.length ? S.attachments.map((a) => ({ ...a })) : null,
      workbook: buildWorkbook(),
      summary: summary.length ? summary : null,
      published: $('m-published').checked,
      sortOrder: m.sortOrder ?? (S.modules.indexOf(m) + 1),
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    };
    await setDoc(doc(db, 'courses', S.slug, 'modules', String(m.id)), payload, { merge: true });

    Object.assign(m, payload, { updatedAt: null });
    btn.disabled = false;
    btn.textContent = 'Save lesson';
    clearDirty();
    ok(out, 'Saved ✓');
    setTimeout(() => { if (!S.dirty) out.innerHTML = ''; }, 2500);
    renderRail();
  } catch (e) {
    const btn = $('btn-module-save');
    btn.disabled = false;
    btn.textContent = 'Save lesson';
    err(out, e);
  }
}

// One-click add (Skool-style): the stub doc is written immediately as a
// draft so members never see it until it's published.
async function addLesson() {
  if (!confirmDiscard()) return;
  try {
    const id = S.modules.reduce((mx, m) => Math.max(mx, m.id), 0) + 1;
    const stub = {
      id,
      title: 'New lesson',
      subtitle: null,
      pillar: null,
      duration: null,
      tagLabel: null,
      html: '',
      videoUrl: null,
      videoFile: null,
      attachments: null,
      workbook: null,
      summary: null,
      published: false,
      sortOrder: S.modules.length + 1,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    };
    await setDoc(doc(db, 'courses', S.slug, 'modules', String(id)), stub, { merge: true });
    S.modules.push({ ...stub, updatedAt: null });
    await syncModuleCount();
    selectModule(id, { force: true });
    const t = $('m-title');
    t.focus();
    t.select();
  } catch (e) {
    alert(`Could not add lesson: ${e && e.message ? e.message : e}`);
  }
}

async function deleteLesson() {
  const m = activeModule();
  if (!m) return;
  if (!confirm(`Delete lesson "${m.title || m.id}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'courses', S.slug, 'modules', String(m.id)));
    S.modules = S.modules.filter((x) => x.id !== m.id);
    await syncModuleCount();
    clearDirty();
    if (S.modules.length) selectModule(S.modules[0].id, { force: true });
    else { S.activeId = null; showEditorEmpty(true); renderRail(); }
  } catch (e) {
    alert(`Could not delete lesson: ${e && e.message ? e.message : e}`);
  }
}

// ─── HTML source + member-view preview ──────────────────────────────────────

function toggleHtmlSource() {
  const src = $('m-html');
  const quillBox = $('m-quill').parentElement;
  const q = ensureQuill();
  if (src.style.display === 'none') {
    src.value = typeof q.getSemanticHTML === 'function' ? q.getSemanticHTML() : q.root.innerHTML;
    src.style.display = 'block';
    quillBox.style.display = 'none';
    $('btn-html-toggle').textContent = 'Back to visual editor';
  } else {
    q.setContents([]);
    if (src.value) q.clipboard.dangerouslyPasteHTML(src.value);
    src.style.display = 'none';
    quillBox.style.display = 'block';
    $('btn-html-toggle').textContent = 'Edit HTML source';
  }
}

let _purify = null;
async function getPurify() {
  if (_purify) return _purify;
  const mod = await import('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs');
  _purify = mod.default || mod;
  return _purify;
}

function resetPreview() {
  S.previewOn = false;
  const box = $('m-preview');
  if (box) box.style.display = 'none';
  const btn = $('btn-preview-toggle');
  if (btn) btn.textContent = 'Preview lesson';
}

// Renders the lesson exactly as course-renderer.js will: video embed above a
// lesson-header + DOMPurify-sanitized lesson-body, plus workbook/summary
// sections when filled in.
async function togglePreview() {
  const box = $('m-preview');
  const quillBox = $('m-quill').parentElement;
  const src = $('m-html');
  const btn = $('btn-preview-toggle');
  if (!S.previewOn) {
    const purify = await getPurify();
    const pillar = $('m-pillar').value.trim();
    const duration = $('m-duration').value.trim();
    const title = $('m-title').value.trim();
    const subtitle = $('m-subtitle').value.trim();
    const eyebrow = [pillar, duration].filter(Boolean).join(' · ');

    const wb = buildWorkbook();
    const summary = splitLines($('m-summary').value);
    const extras =
      (wb ? `<div style="margin-top:24px; border-top:1px solid rgba(255,255,255,.08); padding-top:16px;">
        <div class="academy-eyebrow">Workbook tab</div>
        ${wb.reflection ? `<p style="margin-top:8px;"><b>Reflection.</b> ${escapeHtml(wb.reflection)}</p>` : ''}
        ${wb.action ? `<p><b>Action.</b> ${escapeHtml(wb.action)}</p>` : ''}
        ${wb.prompts.length ? '<ul>' + wb.prompts.map((p) => `<li>${escapeHtml(p)}</li>`).join('') + '</ul>' : ''}
      </div>` : '') +
      (summary.length ? `<div style="margin-top:24px; border-top:1px solid rgba(255,255,255,.08); padding-top:16px;">
        <div class="academy-eyebrow">Summary tab</div>
        <ul style="margin-top:8px;">${summary.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>` : '');

    const attachRows = S.attachments.length
      ? `<div style="margin-top:24px; border-top:1px solid rgba(255,255,255,.08); padding-top:16px;">
          <div class="academy-eyebrow">Resources</div>
          <ul style="margin-top:8px;">${S.attachments.map((a) =>
            `<li>📎 ${escapeHtml(a.name)} <span style="color:var(--gray-mid); font-size:12px;">${formatBytes(a.size)}</span></li>`).join('')}</ul>
        </div>`
      : '';

    box.innerHTML =
      (videoFileHtml(S.videoFile) || videoEmbedHtml($('m-video').value)) +
      `<div class="lesson-header">` +
        (eyebrow ? `<div class="academy-eyebrow">${escapeHtml(eyebrow)}</div>` : '') +
        `<h1>${escapeHtml(title)}</h1>` +
        (subtitle ? `<p class="lesson-subtitle">${escapeHtml(subtitle)}</p>` : '') +
      `</div>` +
      `<div class="lesson-body">${purify.sanitize(quillHtml() || '', { USE_PROFILES: { html: true } })}</div>` +
      attachRows +
      extras;
    S.htmlWasOpen = src.style.display !== 'none';
    quillBox.style.display = 'none';
    src.style.display = 'none';
    box.style.display = 'block';
    btn.textContent = 'Back to editor';
    S.previewOn = true;
  } else {
    box.style.display = 'none';
    if (S.htmlWasOpen) { src.style.display = 'block'; quillBox.style.display = 'none'; }
    else { quillBox.style.display = 'block'; src.style.display = 'none'; }
    btn.textContent = 'Preview lesson';
    S.previewOn = false;
  }
}

// ─── Sales page tab ─────────────────────────────────────────────────────────

const SALES_FIELDS = {
  category: { el: 's-category', kind: 'text' },
  coverImage: { el: 's-cover', kind: 'text' },
  whatYoullLearn: { el: 's-learn', kind: 'lines' },
  requirements: { el: 's-requirements', kind: 'lines' },
  includes: { el: 's-includes', kind: 'lines' },
  description: { el: 's-description', kind: 'paragraphs' }
};

function registrySeed(slug) { return COURSES.find((c) => c.slug === slug) || null; }

function fillSalesForm(c) {
  S.suppress = true;
  S.salesDirty.clear();
  Object.entries(SALES_FIELDS).forEach(([field, spec]) => {
    const el = $(spec.el);
    const v = c ? c[field] : null;
    if (spec.kind === 'text') el.value = v || '';
    else if (spec.kind === 'lines') el.value = Array.isArray(v) ? v.join('\n') : '';
    else el.value = Array.isArray(v) ? v.join('\n\n') : '';
  });
  updateCoverPreview({ normalize: true });

  // "Reset to built-in" only makes sense where the code registry ships copy
  // for this course — resetting deletes the Firestore override so the seed wins.
  const seed = registrySeed(c ? c.slug : null);
  document.querySelectorAll('.mc-reset-field').forEach((btn) => {
    const field = btn.dataset.reset;
    const has = !!(seed && Array.isArray(seed[field]) && seed[field].length);
    btn.style.display = has ? '' : 'none';
  });

  const landing = $('link-view-landing');
  if (landing && c) landing.href = `/course.html?course=${encodeURIComponent(c.slug)}`;
  $('sales-result').innerHTML = '';
  S.suppress = false;
}

// Share pages are the usual cause of a broken cover: people paste the page
// they're looking at, not the image itself. Rewrite the two that have a
// documented direct-file form; everything else is reported honestly below.
function directImageUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';

  // Drive's /uc?export=view endpoint answers hotlinked images with an HTML
  // interstitial often enough to be useless here. /thumbnail returns real
  // image bytes — but only while the file is shared "Anyone with the link".
  const drive = url.match(
    /^https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|thumbnail\?[^#]*id=|uc\?[^#]*id=)([\w-]{10,})/);
  if (drive) return `https://drive.google.com/thumbnail?id=${drive[1]}&sz=w1600`;

  if (/^https?:\/\/(?:www\.)?dropbox\.com\//.test(url)) {
    // Strip first, THEN decide the separator — stripping "?dl=0" can remove
    // the only "?" in the URL, and appending "&raw=1" to that is malformed.
    const stripped = url.replace(/[?&](?:dl|raw)=\d/g, '').replace(/[?&]$/, '');
    return stripped + (stripped.includes('?') ? '&' : '?') + 'raw=1';
  }
  return url;
}

function coverStatus(msg, isError) {
  const el = $('s-cover-status');
  if (!el) return;
  el.innerHTML = msg
    ? `<span style="color:${isError ? '#ff7070' : 'var(--gray-light)'};">${escapeHtml(msg)}</span>`
    : '';
}

// `normalize` is off while the owner is still typing — rewriting the field
// mid-keystroke would fight them. Blur and upload turn it on.
function updateCoverPreview({ normalize = false, okMsg = '' } = {}) {
  const input = $('s-cover');
  const url = normalize ? directImageUrl(input.value) : input.value.trim();
  const img = $('s-cover-preview');

  if (!url) {
    img.classList.remove('on');
    img.removeAttribute('src');
    coverStatus('');
    return;
  }

  // A rewritten share link is written back so what's saved is what loads.
  // Not while filling the form from Firestore — that isn't an owner edit.
  if (url !== input.value.trim()) {
    input.value = url;
    if (!S.suppress) S.salesDirty.add('coverImage');
  }

  coverStatus('Loading image…');
  img.onload = () => { img.classList.add('on'); coverStatus(okMsg); };
  img.onerror = () => {
    img.classList.remove('on');
    coverStatus(/drive\.google\.com/.test(url)
      ? 'Google Drive didn\'t serve that image. Check the file is shared "Anyone with the link" — and note Drive throttles hotlinked images, so covers can vanish later. Use Upload… instead.'
      : 'That link didn\'t load as an image. It needs to point straight at the file (…/cover.jpg), not at a page showing it. Easiest fix: use Upload… instead.', true);
  };
  img.src = url;
}

async function onCoverFilePicked() {
  const input = $('s-cover-file');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !S.slug) return;
  const btn = $('btn-cover-upload');
  btn.disabled = true;
  try {
    coverStatus('Uploading… 0%');
    const meta = await uploadCourseFile(S.slug, 'images', file, (pct) => coverStatus(`Uploading… ${pct}%`));
    $('s-cover').value = meta.url;
    S.salesDirty.add('coverImage');
    updateCoverPreview({ normalize: true, okMsg: 'Uploaded — click Save to publish it.' });
  } catch (e) {
    coverStatus(e && e.message ? e.message : String(e), true);
  } finally {
    btn.disabled = false;
  }
}

async function saveSales() {
  const out = $('sales-result');
  if (!S.salesDirty.size) { ok(out, 'Nothing to save — no changes.'); return; }
  try {
    const payload = { updatedAt: serverTimestamp(), updatedBy: _userEmail };
    S.salesDirty.forEach((field) => {
      const spec = SALES_FIELDS[field];
      const raw = $(spec.el).value;
      if (spec.kind === 'text') payload[field] = raw.trim() || null;
      else if (spec.kind === 'lines') {
        const arr = splitLines(raw);
        payload[field] = arr.length ? arr : null;
      } else {
        const arr = splitParagraphs(raw);
        payload[field] = arr.length ? arr : null;
      }
    });
    await setDoc(doc(db, 'courses', S.slug), payload, { merge: true });
    S.salesDirty.clear();
    ok(out, 'Sales page saved — it\'s live on the landing page now.');
    await reloadCourse();
  } catch (e) { err(out, e); }
}

async function resetSalesField(field) {
  if (!confirm('Reset this section to the built-in copy? Your edited version is removed.')) return;
  const out = $('sales-result');
  try {
    await setDoc(doc(db, 'courses', S.slug), {
      [field]: deleteField(),
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    await reloadCourse();
    fillSalesForm(S.course);
    ok(out, 'Reset to the built-in copy.');
  } catch (e) { err(out, e); }
}

// Rebuild the landing page's "Course content" accordion from the actual
// lessons, so the sales page always matches the curriculum.
async function syncCurriculumFromLessons() {
  const out = $('sales-result');
  const published = S.modules.filter((m) => m.published !== false);
  if (!published.length) { err(out, new Error('No published lessons to sync yet.')); return; }
  if (!confirm(`Rebuild the landing page's "Course content" section from your ${published.length} published lesson${published.length === 1 ? '' : 's'}?`)) return;
  try {
    const curriculum = [{
      title: S.course.title || 'Course content',
      lessons: published.map((m) => ({ t: m.title || `Lesson ${m.id}`, d: m.duration || '' }))
    }];
    await setDoc(doc(db, 'courses', S.slug), {
      curriculum,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    ok(out, 'Landing page course-content preview synced from lessons.');
    await reloadCourse();
  } catch (e) { err(out, e); }
}

// ─── Pricing tab ────────────────────────────────────────────────────────────

function fillPricingForm(c) {
  S.suppress = true;
  $('p-price').value = c && typeof c.price === 'number' ? c.price : '';
  $('p-saleprice').value = c && typeof c.salePrice === 'number' ? c.salePrice : '';
  const mode = c && c.pricing && c.pricing.mode === 'subscription' ? 'subscription' : 'one-time';
  $('p-mode').value = mode;
  $('p-interval').disabled = mode !== 'subscription';
  $('p-interval').value = (c && c.pricing && c.pricing.interval) || 'month';
  $('p-pricenote').value = c ? (c.priceNote || '') : '';
  $('pricing-result').innerHTML = '';
  S.suppress = false;
}

async function savePricing() {
  const out = $('pricing-result');
  try {
    const price = $('p-price').value === '' ? null : Number($('p-price').value);
    const salePrice = $('p-saleprice').value === '' ? null : Number($('p-saleprice').value);
    if (price != null && (!Number.isFinite(price) || price < 0)) throw new Error('Enter a valid price.');
    if (salePrice != null && (!Number.isFinite(salePrice) || salePrice < 0)) throw new Error('Enter a valid sale price.');
    if (salePrice != null && price != null && salePrice >= price) {
      throw new Error('Sale price must be lower than the regular price.');
    }
    const mode = $('p-mode').value;
    await setDoc(doc(db, 'courses', S.slug), {
      price,
      salePrice,
      // Clear the seeded display label so it always derives from `price`.
      priceLabel: null,
      priceNote: $('p-pricenote').value.trim() || null,
      pricing: { mode, interval: mode === 'subscription' ? $('p-interval').value : null },
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    ok(out, 'Pricing saved.');
    await reloadCourse();
  } catch (e) { err(out, e); }
}

// ─── Settings tab ───────────────────────────────────────────────────────────

function fillSettingsForm(c) {
  S.suppress = true;
  $('f-title').value = c ? (c.title || '') : '';
  $('f-short').value = c ? (c.short || '') : '';
  $('f-slug').value = c ? c.slug : '';
  $('f-subtitle').value = c ? (c.subtitle || '') : '';
  $('f-eyebrow').value = c ? (c.eyebrow || '') : '';
  $('f-sort').value = c && typeof c.sortOrder === 'number' ? c.sortOrder : '';
  const contentVal = (c && c.contentSource !== 'firestore' && CODE_CONTENT_SLUGS.has(c.slug)) ? 'code' : 'firestore';
  $('f-content').value = contentVal;
  // Default-true opt-out, same convention as `published` on lessons.
  const onSite = !c || c.showOnSite !== false;
  $('f-onsite').checked = onSite;
  $('f-onsite-label').textContent = onSite ? 'On main site' : 'Hidden from main site';
  $('settings-result').innerHTML = '';
  S.suppress = false;
}

async function saveSettings() {
  const out = $('settings-result');
  try {
    const title = $('f-title').value.trim();
    if (!title) throw new Error('Title is required.');
    const source = $('f-content').value === 'code' ? 'code' : 'firestore';
    if (source === 'firestore' && CODE_CONTENT_SLUGS.has(S.slug) && isCodeContent(S.course)) {
      if (!confirm('Switch this course to editable content? Its lessons will render from the database. If you haven\'t migrated them yet, the course may appear empty until you add lessons.')) {
        fillSettingsForm(S.course);
        return;
      }
    }
    await setDoc(doc(db, 'courses', S.slug), {
      title,
      short: $('f-short').value.trim() || null,
      subtitle: $('f-subtitle').value.trim() || null,
      eyebrow: $('f-eyebrow').value.trim() || null,
      sortOrder: Number($('f-sort').value) || 0,
      contentSource: source,
      showOnSite: $('f-onsite').checked,
      updatedAt: serverTimestamp(),
      updatedBy: _userEmail
    }, { merge: true });
    ok(out, `Saved <b>${escapeHtml(title)}</b>.`);
    $('builder-title').textContent = title;
    await reloadCourse();
    renderCodeBanner();
  } catch (e) { err(out, e); }
}

// ─── Built-in content banner ────────────────────────────────────────────────

function renderCodeBanner() {
  const banner = $('mc-code-banner');
  const workspace = $('mc-workspace');
  const migrate = $('btn-banner-migrate');
  const isCode = isCodeContent(S.course);
  banner.style.display = isCode ? '' : 'none';
  workspace.style.display = isCode ? 'none' : '';
  if (isCode) {
    const migratable = CODE_CONTENT_SLUGS.has(S.slug);
    $('mc-code-banner-text').innerHTML = migratable
      ? 'This course\'s lessons are built into the site code. Migrate them into the builder to edit every lesson right here — members see the same course.'
      : 'This course\'s lessons are built into the site code. Lessons added here will <b>not</b> be shown until the course is switched to editable content (Settings tab).';
    migrate.style.display = migratable ? '' : 'none';
    migrate.disabled = false;
    migrate.textContent = 'Migrate lessons into the builder';
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function openBuilder(slug) {
  S.slug = slug;
  S.course = findCourse(slug);
  if (!S.course) return;
  S.activeId = null;
  clearDirty();

  $('builder-title').textContent = S.course.title || slug;
  renderStatusPill(S.course.status);
  selectBtab('curriculum');
  fillSalesForm(S.course);
  fillPricingForm(S.course);
  fillSettingsForm(S.course);
  renderCodeBanner();

  if (!isCodeContent(S.course)) {
    await refreshModules();
    if (S.modules.length) selectModule(S.modules[0].id, { force: true });
    else { showEditorEmpty(true); }
  } else {
    S.modules = [];
  }
}

export function initBuilder(options = {}) {
  cfg = options;
  _userEmail = options.userEmail || null;

  // Builder tab strip
  document.querySelectorAll('.mc-btab').forEach((t) =>
    t.addEventListener('click', () => selectBtab(t.dataset.btab)));

  // Header actions
  $('btn-preview-course').addEventListener('click', () => {
    if (S.slug) window.open(`courses.html?course=${encodeURIComponent(S.slug)}&preview=1`, '_blank', 'noopener');
  });
  const publish = $('mc-publish');
  $('btn-publish-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    publish.classList.toggle('open');
  });
  document.addEventListener('click', () => publish.classList.remove('open'));
  publish.querySelectorAll('[data-publish]').forEach((b) =>
    b.addEventListener('click', () => {
      publish.classList.remove('open');
      builderSetStatus(b.dataset.publish);
    }));

  // Curriculum
  $('btn-add-module').addEventListener('click', addLesson);
  $('btn-add-module-empty').addEventListener('click', addLesson);
  $('btn-module-save').addEventListener('click', saveModule);
  $('btn-module-delete').addEventListener('click', deleteLesson);
  $('btn-html-toggle').addEventListener('click', toggleHtmlSource);
  $('btn-preview-toggle').addEventListener('click', togglePreview);
  $('btn-video-upload').addEventListener('click', () => $('m-video-file').click());
  $('m-video-file').addEventListener('change', onVideoFilePicked);
  $('btn-attach-upload').addEventListener('click', () => $('m-attach-file').click());
  $('m-attach-file').addEventListener('change', onAttachFilesPicked);
  $('btn-banner-migrate').addEventListener('click', async () => {
    if (!cfg.onMigrate || !S.slug) return;
    const btn = $('btn-banner-migrate');
    btn.disabled = true;
    btn.textContent = 'Migrating…';
    try { await cfg.onMigrate(S.slug); }
    finally {
      btn.disabled = false;
      btn.textContent = 'Migrate lessons into the builder';
    }
  });

  // Dirty tracking + video validation on the lesson form
  const form = $('mc-editor-form');
  form.addEventListener('input', (e) => {
    markDirty();
    if (e.target && e.target.id === 'm-video') updateVideoHint();
  });
  $('m-published').addEventListener('change', () => {
    $('m-published-label').textContent = $('m-published').checked ? 'Published' : 'Draft';
    markDirty();
  });

  // Settings tab: keep the site-visibility label in step with the switch.
  // Not part of markDirty() — that tracks the lesson form, and this lives on
  // the Settings card behind its own Save button.
  $('f-onsite').addEventListener('change', () => {
    $('f-onsite-label').textContent = $('f-onsite').checked ? 'On main site' : 'Hidden from main site';
  });

  // Ctrl/Cmd+S saves the open lesson while the builder is visible
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      const builderVisible = $('builder-view').style.display !== 'none';
      if (!builderVisible) return;
      e.preventDefault();
      const curriculumActive = $('btab-curriculum').classList.contains('is-active');
      if (curriculumActive && S.activeId != null) saveModule();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Sales tab
  Object.entries(SALES_FIELDS).forEach(([field, spec]) => {
    $(spec.el).addEventListener('input', () => {
      if (S.suppress) return;
      S.salesDirty.add(field);
      if (field === 'coverImage') updateCoverPreview();
    });
  });
  $('btn-cover-upload').addEventListener('click', () => $('s-cover-file').click());
  $('s-cover-file').addEventListener('change', onCoverFilePicked);
  $('s-cover').addEventListener('blur', () => updateCoverPreview({ normalize: true }));
  $('btn-save-sales').addEventListener('click', saveSales);
  $('btn-sync-curriculum').addEventListener('click', syncCurriculumFromLessons);
  document.querySelectorAll('.mc-reset-field').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      resetSalesField(btn.dataset.reset);
    }));

  // Pricing tab
  $('p-mode').addEventListener('change', () => {
    $('p-interval').disabled = $('p-mode').value !== 'subscription';
  });
  $('btn-save-pricing').addEventListener('click', savePricing);

  // Settings tab
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-delete-course').addEventListener('click', () => {
    if (S.slug && cfg.onDeleteCourse) cfg.onDeleteCourse(S.slug);
  });
}

/** True when the builder has unsaved lesson edits (used by the back link). */
export function builderHasUnsavedChanges() { return S.dirty; }

/** Clear dirty state after the user confirms leaving the builder. */
export function builderDiscardChanges() { clearDirty(); }
