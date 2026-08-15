// AI course generator — the "✨ Generate with AI" flow on /manage-courses.html.
// Collects a topic/audience/lesson-count brief, then orchestrates two
// admin-only Cloud Functions (functions/index.js):
//   1. generateCourseOutline  → course skeleton (title, sales copy, lesson briefs)
//   2. generateCourseLesson   → full lesson content, called once per lesson
// The browser writes all Firestore docs itself through the same paths the
// manual builder uses, so firestore.rules stays the single security model and
// a cancelled run keeps whatever drafts were already written. Every generated
// lesson lands as published:false — the admin reviews and publishes by hand.

import { db, functions } from './firebase.js';
import {
  doc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { getCourses } from './courses-data.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

const cleanLines = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);

// ─── Reference documents ────────────────────────────────────────────────────
// Manuscripts, notes, and outlines the admin uploads to ground the AI's
// writing. Text is extracted in the browser (nothing is stored) and passed
// to the Cloud Functions as prompt context, trimmed to SOURCE_MAX chars.

const SOURCE_MAX = 60000;
const DOC_FILE_MAX = 20 * 1024 * 1024;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
    _pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';
  }
  return _pdfjs;
}

async function extractPdfText(file) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts = [];
  let total = 0;
  for (let p = 1; p <= doc.numPages && total < SOURCE_MAX * 1.5; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ');
    parts.push(text);
    total += text.length;
  }
  return parts.join('\n');
}

async function extractDocxText(file) {
  if (!window.mammoth) {
    await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js');
  }
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value || '';
}

async function extractDocText(file) {
  const name = file.name.toLowerCase();
  if (file.size > DOC_FILE_MAX) throw new Error(`"${file.name}" is too large (max 20MB).`);
  if (name.endsWith('.pdf')) return extractPdfText(file);
  if (name.endsWith('.docx')) return extractDocxText(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return file.text();
  throw new Error(`"${file.name}" isn't supported — upload a PDF, Word (.docx), .txt, or .md file.`);
}

export function openAiGeneratorModal({ userEmail, onDone }) {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal card" style="max-width:560px;">
        <h3 style="margin:0 0 4px;">✨ Generate a course with AI</h3>
        <p style="font-size:12px; color:var(--gray-light); margin:0 0 14px;">
          Describe the course and AI drafts the outline, sales copy, and every lesson
          (content, workbook, summary). Everything lands as <b>drafts</b> for you to review,
          edit, and publish.
        </p>
        <div class="crm-form" id="ai-form">
          <div class="crm-form-row">
            <label for="ai-topic">What is the course about?</label>
            <textarea id="ai-topic" rows="3" style="resize:vertical;" placeholder="e.g. Building unshakeable morning discipline — habits, routines, and the mindset shifts that make them stick"></textarea>
          </div>
          <div class="crm-form-row">
            <label for="ai-audience">Who is it for? <span style="text-transform:none; letter-spacing:0; color:var(--gray-mid);">(optional)</span></label>
            <input id="ai-audience" type="text" placeholder="e.g. new entrepreneurs who struggle with consistency" autocomplete="off">
          </div>
          <div class="crm-form-row">
            <label for="ai-lessons">Number of lessons</label>
            <select id="ai-lessons">
              ${[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<option value="${n}"${n === 5 ? ' selected' : ''}>${n} lessons</option>`).join('')}
            </select>
          </div>
          <div class="crm-form-row">
            <label for="ai-notes">Anything else the AI should know? <span style="text-transform:none; letter-spacing:0; color:var(--gray-mid);">(optional)</span></label>
            <input id="ai-notes" type="text" placeholder="tone, must-cover topics, frameworks…" autocomplete="off">
          </div>
          <div class="crm-form-row">
            <label>Reference documents <span style="text-transform:none; letter-spacing:0; color:var(--gray-mid);">(optional — manuscripts, notes, or outlines the AI should draw from)</span></label>
            <div id="ai-docs-list"></div>
            <div style="display:flex; gap:10px; align-items:center;">
              <button class="btn btn-ghost" type="button" id="btn-ai-doc" style="font-size:12px;">+ Upload document</button>
              <input type="file" id="ai-doc-file" multiple accept=".pdf,.docx,.txt,.md" style="display:none">
              <span id="ai-doc-status" style="font-size:12px; color:var(--gray-light);"></span>
            </div>
            <div style="font-size:11px; color:var(--gray-mid); margin-top:4px;">
              PDF, Word (.docx), .txt, or .md. Text is read in your browser and used as writing material — very long documents are trimmed to the first ~60,000 characters.
            </div>
          </div>
          <div id="ai-result"></div>
          <div class="crm-modal-actions">
            <button class="btn btn-ghost" type="button" id="ai-cancel">Cancel</button>
            <button class="btn btn-primary" type="button" id="ai-generate">Generate course</button>
          </div>
        </div>
        <div id="ai-progress" style="display:none;">
          <div id="ai-steps" style="display:flex; flex-direction:column; gap:8px; font-size:13px; margin-bottom:14px;"></div>
          <div id="ai-result-2"></div>
          <div class="crm-modal-actions">
            <button class="btn btn-ghost" type="button" id="ai-stop">Stop after this lesson</button>
            <button class="btn btn-primary" type="button" id="ai-close" style="display:none;">Open in builder →</button>
          </div>
        </div>
      </div>
    </div>`;

  let running = false;
  let stopRequested = false;
  let doneSlug = null;
  const docs = [];   // { name, text }

  const close = () => { root.innerHTML = ''; };
  $('modal-bd').addEventListener('click', (e) => {
    if (e.target.id === 'modal-bd' && !running) close();
  });
  $('ai-cancel').addEventListener('click', close);
  $('ai-topic').focus();

  function renderDocsList() {
    const list = $('ai-docs-list');
    if (!docs.length) { list.innerHTML = ''; return; }
    list.innerHTML = docs.map((d, i) => `
      <div style="display:flex; gap:10px; align-items:center; padding:5px 0; font-size:13px;">
        <span>📄</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(d.name)}</span>
        <span style="color:var(--gray-mid); font-size:12px;">${Math.round(d.text.length / 1000)}k chars</span>
        <span style="flex:1;"></span>
        <button class="mc-reset-field" type="button" data-doc-remove="${i}">remove</button>
      </div>`).join('');
    list.querySelectorAll('[data-doc-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        docs.splice(Number(b.dataset.docRemove), 1);
        renderDocsList();
      }));
  }

  $('btn-ai-doc').addEventListener('click', () => $('ai-doc-file').click());
  $('ai-doc-file').addEventListener('change', async () => {
    const input = $('ai-doc-file');
    const files = Array.from(input.files || []);
    input.value = '';
    const status = $('ai-doc-status');
    for (const f of files) {
      try {
        status.textContent = `Reading ${f.name}…`;
        const text = (await extractDocText(f)).trim();
        if (!text) throw new Error(`No readable text found in "${f.name}" (scanned/image-only PDFs can't be read).`);
        docs.push({ name: f.name, text });
        renderDocsList();
        status.textContent = '';
      } catch (e) {
        status.innerHTML = `<span style="color:var(--red, #ff7070);">${escapeHtml(e && e.message ? e.message : String(e))}</span>`;
      }
    }
  });

  // Combine every uploaded document into one prompt-context block.
  function combinedSource() {
    if (!docs.length) return '';
    const joined = docs.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n');
    return joined.length > SOURCE_MAX ? joined.slice(0, SOURCE_MAX) + '\n[…trimmed]' : joined;
  }

  const steps = () => $('ai-steps');
  function addStep(text) {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color:var(--gray-light);">⏳ ${escapeHtml(text)}</span>`;
    steps().appendChild(el);
    return {
      done(note) { el.innerHTML = `<span style="color:#2ecc71;">✓</span> ${escapeHtml(text)}${note ? ` <span style="color:var(--gray-mid);">— ${escapeHtml(note)}</span>` : ''}`; },
      fail(note) { el.innerHTML = `<span style="color:var(--red, #ff7070);">✗ ${escapeHtml(text)}${note ? ` — ${escapeHtml(note)}` : ''}</span>`; }
    };
  }

  async function run() {
    const out = $('ai-result');
    const topic = $('ai-topic').value.trim();
    if (!topic) {
      out.innerHTML = '<div class="auth-error">Describe what the course is about first.</div>';
      return;
    }
    const audience = $('ai-audience').value.trim();
    const notes = $('ai-notes').value.trim();
    const lessonCount = Number($('ai-lessons').value) || 5;
    const source = combinedSource();

    running = true;
    $('ai-form').style.display = 'none';
    $('ai-progress').style.display = 'block';
    $('ai-stop').addEventListener('click', () => {
      stopRequested = true;
      $('ai-stop').disabled = true;
      $('ai-stop').textContent = 'Stopping…';
    });

    const finish = (slug, message, isError) => {
      running = false;
      doneSlug = slug || null;
      const out2 = $('ai-result-2');
      out2.innerHTML = `<div class="${isError ? 'auth-error' : 'auth-ok'}">${message}</div>`;
      $('ai-stop').style.display = 'none';
      const closeBtn = $('ai-close');
      closeBtn.style.display = '';
      if (!doneSlug) closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', async () => {
        close();
        if (doneSlug && onDone) await onDone(doneSlug);
      });
    };

    // 1. Outline
    const outlineStep = addStep(docs.length
      ? `Designing the course outline from ${docs.length} reference document${docs.length === 1 ? '' : 's'}…`
      : 'Designing the course outline…');
    let outline;
    try {
      const res = await httpsCallable(functions, 'generateCourseOutline')({ topic, audience, notes, lessonCount, source });
      outline = res.data && res.data.outline;
      if (!outline || !Array.isArray(outline.lessons) || !outline.lessons.length) {
        throw new Error('The AI returned an empty outline.');
      }
      outlineStep.done(`"${outline.title || 'Untitled'}" · ${outline.lessons.length} lessons`);
    } catch (e) {
      outlineStep.fail(e && e.message ? e.message : String(e));
      finish(null, 'Could not generate the outline — nothing was created. Try again with a more specific description.', true);
      return;
    }

    // 2. Course doc (same shape as the manual "New course" modal, plus the
    //    AI-drafted sales copy).
    const title = String(outline.title || topic).slice(0, 120);
    let slug = slugify(title);
    const taken = new Set(getCourses({ includeInactive: true }).map((c) => c.slug));
    if (taken.has(slug)) {
      let n = 2;
      while (taken.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    const courseStep = addStep(`Creating course "${title}"…`);
    try {
      await setDoc(doc(db, 'courses', slug), {
        slug,
        title,
        short: String(outline.short || '').trim().slice(0, 30) || null,
        subtitle: String(outline.subtitle || '').trim() || null,
        category: String(outline.category || '').trim() || null,
        description: cleanLines(outline.description).length ? cleanLines(outline.description) : null,
        whatYoullLearn: cleanLines(outline.whatYoullLearn).length ? cleanLines(outline.whatYoullLearn) : null,
        status: 'coming-soon',
        contentSource: 'firestore',
        moduleCount: 0,
        priceLabel: null,
        pricing: { mode: 'one-time', interval: null },
        sortOrder: getCourses({ includeInactive: true }).length,
        updatedAt: serverTimestamp(),
        updatedBy: userEmail
      }, { merge: true });
      courseStep.done(`/course.html?course=${slug}`);
    } catch (e) {
      courseStep.fail(e && e.message ? e.message : String(e));
      finish(null, 'Could not create the course document — nothing was saved.', true);
      return;
    }

    // 3. Lessons — sequential so progress is honest and rate limits are safe.
    const outlineTitles = outline.lessons.map((l) => String(l.title || ''));
    let written = 0;
    let skipped = 0;
    for (let i = 0; i < outline.lessons.length; i++) {
      if (stopRequested) break;
      const l = outline.lessons[i] || {};
      const step = addStep(`Writing lesson ${i + 1} of ${outline.lessons.length}: ${l.title || 'Untitled'}…`);
      let lesson = null;
      for (let attempt = 0; attempt < 2 && !lesson; attempt++) {
        try {
          const res = await httpsCallable(functions, 'generateCourseLesson')({
            courseTitle: title,
            audience,
            lessonTitle: String(l.title || `Lesson ${i + 1}`),
            lessonSubtitle: String(l.subtitle || ''),
            brief: String(l.brief || ''),
            lessonNumber: i + 1,
            totalLessons: outline.lessons.length,
            outlineTitles,
            source
          });
          lesson = res.data && res.data.lesson;
        } catch (e) {
          if (attempt === 1) {
            step.fail(`skipped — ${e && e.message ? e.message : e}`);
            skipped++;
          }
        }
      }
      if (!lesson) continue;
      try {
        const wb = lesson.workbook;
        await setDoc(doc(db, 'courses', slug, 'modules', String(i + 1)), {
          id: i + 1,
          title: String(l.title || `Lesson ${i + 1}`).slice(0, 200),
          subtitle: String(l.subtitle || '').trim() || null,
          pillar: String(l.pillar || '').trim() || null,
          duration: String(l.duration || '').trim() || null,
          tagLabel: String(l.tagLabel || '').trim() || null,
          html: String(lesson.html || ''),
          videoUrl: null,
          videoFile: null,
          attachments: null,
          workbook: wb ? {
            reflection: String(wb.reflection || '').trim() || null,
            action: String(wb.action || '').trim() || null,
            prompts: cleanLines(wb.prompts)
          } : null,
          summary: cleanLines(lesson.summary).length ? cleanLines(lesson.summary) : null,
          published: false,
          sortOrder: i + 1,
          updatedAt: serverTimestamp(),
          updatedBy: userEmail
        }, { merge: true });
        written++;
        step.done('draft saved');
      } catch (e) {
        step.fail(`could not save — ${e && e.message ? e.message : e}`);
        skipped++;
      }
    }

    try {
      await setDoc(doc(db, 'courses', slug), {
        moduleCount: written,
        updatedAt: serverTimestamp(),
        updatedBy: userEmail
      }, { merge: true });
    } catch (e) { console.warn('[course-ai] moduleCount sync failed', e); }

    const summaryMsg = stopRequested
      ? `Stopped — ${written} draft lesson${written === 1 ? '' : 's'} were created before stopping.`
      : `Done — ${written} draft lesson${written === 1 ? '' : 's'} created${skipped ? ` (${skipped} skipped after errors)` : ''}. Review, edit, and publish them in the builder.`;
    finish(slug, summaryMsg, written === 0);
  }

  $('ai-generate').addEventListener('click', () => {
    run().catch((e) => {
      running = false;
      const out2 = $('ai-result-2');
      if (out2) out2.innerHTML = `<div class="auth-error">${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
    });
  });
}
