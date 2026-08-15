// Shared Coursera-style course player — the single in-course UI every course
// renders through (sidebar module list + progress, topbar, tabbed lesson pane,
// prev/complete footer). Extracted from the I Can't course workspace so all
// courses look and behave identically once a member is inside a course.
//
// Usage:
//   mountCoursePlayer({
//     container,            // element to render into (defaults to #workspace-player)
//     brand,                // small eyebrow above the course title in the sidebar
//     courseTitle,          // sidebar course title
//     modules,              // [{ id, title, subtitle, eyebrow, duration, meta }]
//     tabs,                 // [{ id, label, html(mod), bind?(rootEl, mod) }]
//     progress,             // { isComplete(id), markComplete(id)→Promise, onNavigate?(id) }
//     moduleHeaderHtml?,    // (mod) → extra html under the module title (e.g. ALIGN bar)
//     sidebarFooterHtml?,   // () → html pinned at the bottom of the sidebar
//     labels?,              // { complete, completeLast, completed, completedLast }
//     certificateHref?,     // when every module is done, the last module shows a
//                           // completion panel and the footer CTA links here
//     startAt               // module id to open first
//   })

import { courseCompleteHtml } from './certificate.js';

export function escPlayer(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const esc = escPlayer;

const DEFAULT_LABELS = {
  complete: 'Mark Complete & Continue →',
  completeLast: 'Mark Complete & Finish →',
  completed: '✓ Completed — Next Module →',
  completedLast: '✓ Course Complete'
};

export function mountCoursePlayer(config) {
  const container = config.container || document.getElementById('workspace-player');
  if (!container) return null;

  const modules = config.modules || [];
  const tabs = config.tabs || [];
  const labels = { ...DEFAULT_LABELS, ...(config.labels || {}) };
  const progress = config.progress || { isComplete: () => false, markComplete: async () => {} };

  const state = {
    activeId: modules.length ? modules[0].id : null,
    tab: tabs.length ? tabs[0].id : null,
    // Sidebar starts closed on narrow screens so the lesson gets the width.
    sidebarOpen: window.innerWidth > 900
  };

  if (config.startAt != null && modules.some((m) => m.id === config.startAt)) {
    state.activeId = config.startAt;
  }

  const idx = () => modules.findIndex((m) => m.id === state.activeId);
  const current = () => modules[idx()];
  const completedCount = () => modules.filter((m) => progress.isComplete(m.id)).length;

  function sidebarHtml() {
    const done = completedCount();
    const pct = modules.length ? Math.round((done / modules.length) * 100) : 0;

    const items = modules.map((m, i) => {
      const isActive = m.id === state.activeId;
      const isDone = progress.isComplete(m.id);
      return `
        <button class="cp-mod ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}" data-mod="${esc(m.id)}">
          <span class="cp-mod-num">${isDone ? '✓' : i + 1}</span>
          <span class="cp-mod-text">
            <span class="cp-mod-title">${esc(m.title)}</span>
            <span class="cp-mod-meta">${esc(m.meta || m.duration || '')}</span>
          </span>
        </button>`;
    }).join('');

    return `
      <div class="cp-sidebar-head">
        <div class="cp-brand">${esc(config.brand || 'KAILEY BROWN')}</div>
        <div class="cp-course-title">${esc(config.courseTitle || '')}</div>
        <div class="cp-progress">
          <div class="cp-progress-bar"><div class="cp-progress-fill" style="width:${pct}%"></div></div>
          <span class="cp-progress-label">${done}/${modules.length} modules</span>
        </div>
      </div>
      <div class="cp-modlist">${items}</div>
      ${config.sidebarFooterHtml ? `<div class="cp-sidebar-foot">${config.sidebarFooterHtml()}</div>` : ''}`;
  }

  function moduleHtml(mod) {
    const i = idx();
    const isDone = progress.isComplete(mod.id);
    const eyebrowBits = [`Module ${i + 1}`, mod.eyebrow, mod.duration]
      .filter(Boolean).map((s) => esc(String(s).toUpperCase())).join(' · ');

    const tabBtns = tabs.map((t) => `
      <button class="cp-tab ${state.tab === t.id ? 'is-active' : ''}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('');

    const activeTab = tabs.find((t) => t.id === state.tab) || tabs[0];
    const content = activeTab ? activeTab.html(mod) : '';

    const isLast = i === modules.length - 1;
    const completeLabel = isDone
      ? (isLast ? labels.completedLast : labels.completed)
      : (isLast ? labels.completeLast : labels.complete);

    // The course is only "finished" once every module is done — not just the
    // last one — so someone who skipped module 3 doesn't get a certificate for
    // reaching the end.
    const allDone = modules.length > 0 && completedCount() === modules.length;
    const showCert = allDone && isLast && !!config.certificateHref;
    const certPanel = showCert ? courseCompleteHtml({ href: config.certificateHref }) : '';
    // Reaching the end with the course finished: the dead "✓ Course Complete"
    // button becomes the way to the certificate.
    const footCta = showCert
      ? `<a class="cp-btn cp-btn-primary" href="${esc(config.certificateHref)}">Get your certificate →</a>`
      : `<button class="cp-btn ${isDone ? 'cp-btn-done' : 'cp-btn-primary'}" id="cp-complete" ${isDone && isLast ? 'disabled' : ''}>${esc(completeLabel)}</button>`;

    return `
      <div class="cp-module">
        <div class="cp-module-head">
          <div class="cp-module-head-row">
            <div class="cp-module-head-main">
              <div class="cp-eyebrow">${eyebrowBits}</div>
              <h1 class="cp-module-title">${esc(mod.title)}</h1>
              ${mod.subtitle ? `<p class="cp-module-sub">${esc(mod.subtitle)}</p>` : ''}
            </div>
            ${isDone ? '<div class="cp-complete-badge">✓ Complete</div>' : ''}
          </div>
          ${config.moduleHeaderHtml ? config.moduleHeaderHtml(mod) : ''}
          ${tabs.length > 1 ? `<div class="cp-tabs">${tabBtns}</div>` : ''}
        </div>
        <div class="cp-tab-content" id="cp-tab-content">${content}</div>
        ${certPanel}
        <div class="cp-footbar">
          <button class="cp-btn cp-btn-ghost" id="cp-prev" ${i === 0 ? 'disabled' : ''}>← Previous</button>
          <div class="cp-footbar-pos">Module ${i + 1} of ${modules.length}</div>
          ${footCta}
        </div>
      </div>`;
  }

  function fullHtml() {
    const done = completedCount();
    const pct = modules.length ? Math.round((done / modules.length) * 100) : 0;
    const mod = current();
    return `
      <div class="cp-shell">
        <aside class="cp-sidebar ${state.sidebarOpen ? '' : 'is-closed'}" id="cp-sidebar">${sidebarHtml()}</aside>
        <div class="cp-main">
          <div class="cp-topbar">
            <button class="cp-toggle" id="cp-toggle" aria-label="Toggle module list">≡</button>
            <div class="cp-topbar-spacer"></div>
            <span class="cp-topbar-count">${done}/${modules.length} complete</span>
            <div class="cp-minibar"><div class="cp-minibar-fill" style="width:${pct}%"></div></div>
          </div>
          ${mod ? moduleHtml(mod) : '<div class="cl-loading">Course content is being prepared. Check back soon.</div>'}
        </div>
      </div>`;
  }

  function goTo(id) {
    if (!modules.some((m) => m.id === id)) return;
    state.activeId = id;
    state.tab = tabs.length ? tabs[0].id : null;
    if (progress.onNavigate) { try { progress.onNavigate(id); } catch (e) {} }
    render();
  }

  function render() {
    container.innerHTML = fullHtml();
    bind();
    const pane = container.querySelector('#cp-tab-content');
    if (pane) pane.scrollTop = 0;
  }

  function bindTabContent() {
    const mod = current();
    const activeTab = tabs.find((t) => t.id === state.tab) || tabs[0];
    const pane = container.querySelector('#cp-tab-content');
    if (pane && activeTab && activeTab.bind) activeTab.bind(pane, mod);
  }

  function bind() {
    container.querySelectorAll('.cp-mod').forEach((btn) => {
      btn.addEventListener('click', () => {
        goTo(isNaN(Number(btn.dataset.mod)) ? btn.dataset.mod : Number(btn.dataset.mod));
        if (window.innerWidth <= 900) { state.sidebarOpen = false; render(); }
      });
    });

    container.querySelectorAll('.cp-tab').forEach((btn) => {
      btn.addEventListener('click', () => { state.tab = btn.dataset.tab; render(); });
    });

    const toggle = container.querySelector('#cp-toggle');
    if (toggle) toggle.addEventListener('click', () => { state.sidebarOpen = !state.sidebarOpen; render(); });

    const prev = container.querySelector('#cp-prev');
    if (prev) prev.addEventListener('click', () => {
      const i = idx();
      if (i > 0) goTo(modules[i - 1].id);
    });

    const complete = container.querySelector('#cp-complete');
    if (complete) complete.addEventListener('click', async () => {
      const mod = current();
      const i = idx();
      const isLast = i === modules.length - 1;
      if (!progress.isComplete(mod.id)) {
        complete.disabled = true;
        try { await progress.markComplete(mod.id); } catch (e) { console.warn('[course-player] markComplete failed', e); }
      }
      if (!isLast) goTo(modules[i + 1].id); else render();
    });

    bindTabContent();
  }

  render();

  return { goTo, render };
}
