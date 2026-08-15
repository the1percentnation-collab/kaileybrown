// /events.html — community events list + owner-only create modal.
//
// Backend storage: events/{eventId} top-level collection. Reads are
// open to any signed-in user; writes are owner-only by Firestore rules.
// No callable functions needed for v1 — the owner writes the doc
// directly via setDoc (rules gate it).

import { auth, db, functions, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { getUserProfile, escapeHtml, fmtRelative, uploadEventImage } from './community.js';
import { STAGES } from './crm.js';
import { renderTopbar, renderTopbarEarly } from './topbar.js';
import {
  collection, doc, getDoc, getDocs, query, orderBy, where, limit,
  setDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  role: null,
  companyId: null,
  events: [],
  filter: 'upcoming',
  myRegistrations: new Set()
};

function fmtEventDate(ts, endTs) {
  if (!ts) return 'TBA';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return 'TBA';
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  const time = d.toLocaleTimeString(undefined, timeOpts);
  const end = endTs && (endTs.toDate ? endTs.toDate() : new Date(endTs));
  if (end && !isNaN(end.getTime())) {
    const sameDay = end.toDateString() === d.toDateString();
    return sameDay
      ? `${date} · ${time} – ${end.toLocaleTimeString(undefined, timeOpts)}`
      : `${date} · ${time} – ${end.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${end.toLocaleTimeString(undefined, timeOpts)}`;
  }
  return `${date} · ${time}`;
}

async function loadEvents() {
  state.events = [];
  if (!firebaseReady) return;
  try {
    const snap = await getDocs(query(collection(db, 'events'), orderBy('startsAt', 'desc'), limit(50)));
    state.events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('[events] load failed', err);
  }
}

function eventDateBadge(ts) {
  if (!ts) return { month: '—', day: 'TBA' };
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return { month: '—', day: 'TBA' };
  return {
    month: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
    day: String(d.getDate())
  };
}

function eventCardHtml(e) {
  const canEdit = state.role === 'owner' || (state.role === 'admin');
  const badge = eventDateBadge(e.startsAt);
  const linkBtn = e.link
    ? `<a class="btn btn-primary c-event-cta" href="${escapeHtml(e.link)}" target="_blank" rel="noopener">Join event →</a>`
    : '';
  const shareBtn = canEdit && state.companyId
    ? `<button class="c-event-ctl" data-share="${escapeHtml(e.id)}" title="Share to CRM" aria-label="Share to CRM">↗</button>`
    : '';
  const controls = canEdit
    ? `<div class="c-event-controls">
        ${shareBtn}
        <button class="c-event-ctl" data-edit="${escapeHtml(e.id)}" title="Edit event" aria-label="Edit event">✎</button>
        <button class="c-event-ctl c-event-del" data-del="${escapeHtml(e.id)}" title="Delete event" aria-label="Delete event">✕</button>
      </div>`
    : '';
  const cover = e.imageUrl
    ? `<div class="c-event-cover"><img src="${escapeHtml(e.imageUrl)}" alt="" loading="lazy"></div>`
    : '';

  const isRegistered = state.myRegistrations && state.myRegistrations.has(e.id);
  const registerBtn = isRegistered
    ? `<button class="btn c-event-cta c-event-registered" disabled>Registered ✓</button>`
    : `<button class="btn btn-primary c-event-cta" data-register="${escapeHtml(e.id)}">Register</button>`;

  const count = Number(e.registrationCount || 0);
  const countLine = canEdit
    ? `<button class="c-event-regcount" data-registrants="${escapeHtml(e.id)}">${count} registered · View list</button>`
    : '';

  return `
    <article class="c-event-card${e.imageUrl ? ' has-cover' : ''}" data-event="${escapeHtml(e.id)}">
      ${cover}
      <div class="c-event-main">
        <div class="c-event-datebadge">
          <span class="c-ev-month">${escapeHtml(badge.month)}</span>
          <span class="c-ev-day">${escapeHtml(badge.day)}</span>
        </div>
        <div class="c-event-body">
          <div class="c-event-title">${escapeHtml(e.title || 'Untitled event')}</div>
          <div class="c-event-when">${escapeHtml(fmtEventDate(e.startsAt, e.endsAt))}</div>
          ${e.location ? `<div class="c-event-loc"><span class="c-event-meta-ic">📍</span>${escapeHtml(e.location)}</div>` : ''}
          ${e.hostName ? `<div class="c-event-host">Hosted by ${escapeHtml(e.hostName)}</div>` : ''}
          ${e.description ? `<div class="c-event-desc">${escapeHtml(e.description)}</div>` : ''}
          <div class="c-event-actions">
            ${registerBtn}
            ${linkBtn}
          </div>
          ${countLine}
        </div>
      </div>
      ${controls}
    </article>
  `;
}

function renderList() {
  const root = $('events-list');
  const emptyEl = $('events-empty');
  if (!root || !emptyEl) return;

  const now = Date.now();
  const filtered = state.events.filter((e) => {
    const ts = e.startsAt && e.startsAt.toMillis ? e.startsAt.toMillis() : 0;
    if (!ts) return state.filter === 'upcoming'; // undated → bucket with upcoming
    return state.filter === 'upcoming' ? ts >= now : ts < now;
  }).sort((a, b) => {
    const at = a.startsAt && a.startsAt.toMillis ? a.startsAt.toMillis() : 0;
    const bt = b.startsAt && b.startsAt.toMillis ? b.startsAt.toMillis() : 0;
    return state.filter === 'upcoming' ? at - bt : bt - at;
  });

  if (!filtered.length) {
    root.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.innerHTML = `
      <div class="c-empty-art" aria-hidden="true">📅</div>
      <div class="c-empty-title">${state.filter === 'upcoming' ? 'No upcoming events' : 'No past events'}</div>
      <p class="c-empty-body">${state.filter === 'upcoming'
        ? 'Check back soon, or ask an organizer to schedule the next one.'
        : 'Past events will appear here once they wrap.'}</p>
      ${state.role === 'owner'
        ? `<button class="btn btn-primary c-empty-cta" id="empty-new-event">Schedule an event</button>`
        : ''}
    `;
    const btn = $('empty-new-event');
    if (btn) btn.addEventListener('click', openEventModal);
    return;
  }

  emptyEl.hidden = true;
  root.innerHTML = filtered.map(eventCardHtml).join('');
  root.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ev = state.events.find((x) => x.id === btn.dataset.edit);
      if (ev) openEventModal(ev);
    });
  });
  root.querySelectorAll('[data-share]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ev = state.events.find((x) => x.id === btn.dataset.share);
      if (ev) openShareModal(ev);
    });
  });
  root.querySelectorAll('[data-register]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ev = state.events.find((x) => x.id === btn.dataset.register);
      if (ev) openRegisterModal(ev);
    });
  });
  root.querySelectorAll('[data-registrants]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ev = state.events.find((x) => x.id === btn.dataset.registrants);
      if (ev) openRegistrantsModal(ev);
    });
  });
  root.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.del;
      if (!confirm('Delete this event?')) return;
      try {
        await deleteDoc(doc(db, 'events', id));
        state.events = state.events.filter((ev) => ev.id !== id);
        renderList();
      } catch (err) {
        alert('Could not delete: ' + (err.message || err));
      }
    });
  });
}

function bindToolbar() {
  document.querySelectorAll('.c-events-tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      document.querySelectorAll('.c-events-tab').forEach((x) =>
        x.classList.toggle('is-active', x === b));
      renderList();
    });
  });
  const newBtn = $('btn-new-event');
  if (newBtn) newBtn.addEventListener('click', openEventModal);
}

function openEventModal(prefill = null) {
  if (document.getElementById('c-event-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'c-modal-overlay';
  overlay.id = 'c-event-modal';
  overlay.innerHTML = `
    <div class="c-modal" role="dialog" aria-modal="true">
      <button class="c-modal-close" id="c-event-close" aria-label="Close">✕</button>
      <h2 class="c-modal-title">${prefill ? 'Edit event' : 'Schedule event'}</h2>
      <p class="c-modal-sub">Visible to all signed-in members.</p>
      <div class="c-modal-body">
        <label class="c-invite-label" for="c-ev-title">Title</label>
        <input id="c-ev-title" class="c-ch-input" type="text" maxlength="80" value="${escapeHtml(prefill ? prefill.title : '')}">

        <label class="c-invite-label">Flyer / cover image (optional)</label>
        <div class="c-ev-image-field">
          <div class="c-ev-image-drop" id="c-ev-image-drop">
            <img id="c-ev-image-preview" class="c-ev-image-preview" alt="" hidden>
            <div class="c-ev-image-empty" id="c-ev-image-empty">
              <span class="c-ev-image-ic">🖼️</span>
              <span>Click to upload an image</span>
              <span class="c-ev-image-hint">PNG or JPG, up to 10MB</span>
            </div>
            <button type="button" class="c-ev-image-remove" id="c-ev-image-remove" title="Remove image" hidden>✕</button>
          </div>
          <input id="c-ev-image-input" type="file" accept="image/*" hidden>
        </div>

        <label class="c-invite-label">Starts</label>
        <div class="c-dt-row">
          <div class="c-dt-wrap">
            <button type="button" class="c-dt-field" id="c-start-date-btn">
              <svg class="c-dt-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              <span class="c-dt-text c-dt-placeholder" id="c-start-date-label">Select date</span>
            </button>
            <div class="c-dt-pop" id="c-start-date-pop" hidden></div>
          </div>
          <div class="c-dt-wrap c-dt-wrap-time">
            <button type="button" class="c-dt-field" id="c-start-time-btn">
              <svg class="c-dt-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="c-dt-text c-dt-placeholder" id="c-start-time-label">Select time</span>
            </button>
            <div class="c-dt-pop c-dt-pop-time" id="c-start-time-pop" hidden></div>
          </div>
        </div>

        <label class="c-invite-label">Ends (optional)</label>
        <div class="c-dt-row">
          <div class="c-dt-wrap">
            <button type="button" class="c-dt-field" id="c-end-date-btn">
              <svg class="c-dt-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              <span class="c-dt-text c-dt-placeholder" id="c-end-date-label">Select date</span>
            </button>
            <div class="c-dt-pop" id="c-end-date-pop" hidden></div>
          </div>
          <div class="c-dt-wrap c-dt-wrap-time">
            <button type="button" class="c-dt-field" id="c-end-time-btn">
              <svg class="c-dt-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="c-dt-text c-dt-placeholder" id="c-end-time-label">Select time</span>
            </button>
            <div class="c-dt-pop c-dt-pop-time" id="c-end-time-pop" hidden></div>
          </div>
        </div>

        <label class="c-invite-label" for="c-ev-host">Host name</label>
        <input id="c-ev-host" class="c-ch-input" type="text" maxlength="60" value="${escapeHtml(prefill ? (prefill.hostName || '') : (state.me ? state.me.displayName || '' : ''))}">

        <label class="c-invite-label" for="c-ev-link">Join link (optional)</label>
        <input id="c-ev-link" class="c-ch-input" type="url" placeholder="https://zoom.us/j/...">

        <label class="c-invite-label" for="c-ev-loc">Location (optional)</label>
        <input id="c-ev-loc" class="c-ch-input" type="text" maxlength="120" placeholder="Online · Zoom · 123 Main St">

        <label class="c-invite-label" for="c-ev-desc">Description (optional)</label>
        <textarea id="c-ev-desc" class="c-ch-input" rows="3" maxlength="600"></textarea>

        <div class="c-invite-actions">
          <button class="btn btn-primary" id="c-ev-save">${prefill ? 'Save' : 'Create event'}</button>
          <button class="btn btn-ghost" id="c-ev-cancel">Cancel</button>
        </div>
        <div class="auth-error" id="c-ev-err" style="display:none;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Custom calendar + time picker (one reusable instance per row) ──
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEK = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const today = new Date();
  const allPops = [];          // every pop element, for global close
  const closePops = () => allPops.forEach((p) => { p.hidden = true; });

  function makePicker(prefix, initDate) {
    const sel = {
      day: initDate ? { y: initDate.getFullYear(), m: initDate.getMonth(), d: initDate.getDate() } : null,
      time: initDate ? { h: initDate.getHours(), min: initDate.getMinutes() } : null
    };
    let viewY = sel.day ? sel.day.y : today.getFullYear();
    let viewM = sel.day ? sel.day.m : today.getMonth();

    const datePop = $(`c-${prefix}-date-pop`);
    const timePop = $(`c-${prefix}-time-pop`);
    allPops.push(datePop, timePop);

    const getValue = () => (sel.day && sel.time)
      ? new Date(sel.day.y, sel.day.m, sel.day.d, sel.time.h, sel.time.min)
      : null;

    function refreshLabels() {
      const dl = $(`c-${prefix}-date-label`);
      const tl = $(`c-${prefix}-time-label`);
      if (sel.day) {
        const d = new Date(sel.day.y, sel.day.m, sel.day.d);
        dl.textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        dl.classList.remove('c-dt-placeholder');
      } else { dl.textContent = 'Select date'; dl.classList.add('c-dt-placeholder'); }
      if (sel.time) {
        const h12 = ((sel.time.h + 11) % 12) + 1;
        const ap = sel.time.h < 12 ? 'AM' : 'PM';
        tl.textContent = `${h12}:${String(sel.time.min).padStart(2, '0')} ${ap}`;
        tl.classList.remove('c-dt-placeholder');
      } else { tl.textContent = 'Select time'; tl.classList.add('c-dt-placeholder'); }
    }

    function renderCalendar() {
      const first = new Date(viewY, viewM, 1).getDay();
      const days = new Date(viewY, viewM + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < first; i++) cells += `<span class="c-cal-cell c-cal-blank"></span>`;
      for (let d = 1; d <= days; d++) {
        const isSel = sel.day && sel.day.y === viewY && sel.day.m === viewM && sel.day.d === d;
        const isToday = today.getFullYear() === viewY && today.getMonth() === viewM && today.getDate() === d;
        cells += `<button type="button" class="c-cal-cell c-cal-day${isSel ? ' is-sel' : ''}${isToday ? ' is-today' : ''}" data-day="${d}">${d}</button>`;
      }
      datePop.innerHTML = `
        <div class="c-cal-head">
          <button type="button" class="c-cal-nav" data-nav="-1" aria-label="Previous month">‹</button>
          <span class="c-cal-title">${MONTHS[viewM]} ${viewY}</span>
          <button type="button" class="c-cal-nav" data-nav="1" aria-label="Next month">›</button>
        </div>
        <div class="c-cal-week">${WEEK.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="c-cal-grid">${cells}</div>
      `;
      datePop.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        viewM += Number(b.dataset.nav);
        if (viewM < 0) { viewM = 11; viewY--; }
        if (viewM > 11) { viewM = 0; viewY++; }
        renderCalendar();
      }));
      datePop.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.day = { y: viewY, m: viewM, d: Number(b.dataset.day) };
        refreshLabels();
        renderCalendar();
        closePops();
      }));
    }

    function renderTime() {
      const curH = sel.time ? sel.time.h : -1;
      const curMin = sel.time ? sel.time.min : -1;
      const hours = Array.from({ length: 12 }, (_, i) => i + 1);
      const mins = Array.from({ length: 12 }, (_, i) => i * 5);
      const curAp = curH < 0 ? '' : (curH < 12 ? 'AM' : 'PM');
      const curH12 = curH < 0 ? -1 : (((curH + 11) % 12) + 1);
      timePop.innerHTML = `
        <div class="c-time-cols">
          <div class="c-time-col" data-col="h">${hours.map((h) => `<button type="button" class="c-time-opt${h === curH12 ? ' is-sel' : ''}" data-h="${h}">${h}</button>`).join('')}</div>
          <div class="c-time-col" data-col="m">${mins.map((m) => `<button type="button" class="c-time-opt${m === curMin ? ' is-sel' : ''}" data-m="${String(m).padStart(2,'0')}">${String(m).padStart(2,'0')}</button>`).join('')}</div>
          <div class="c-time-col c-time-col-ap">${['AM','PM'].map((a) => `<button type="button" class="c-time-opt${a === curAp ? ' is-sel' : ''}" data-ap="${a}">${a}</button>`).join('')}</div>
        </div>
        <button type="button" class="c-time-done" data-done>Done</button>
      `;
      // Defaults so a partial selection still commits (e.g. just hour + AM/PM).
      const draft = {
        h12: curH12 > 0 ? curH12 : 12,
        min: curMin >= 0 ? curMin : 0,
        ap: curAp || 'AM'
      };
      const commit = () => {
        let h24 = draft.h12 % 12;
        if (draft.ap === 'PM') h24 += 12;
        sel.time = { h: h24, min: draft.min };
        refreshLabels();
      };
      timePop.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); draft.h12 = Number(b.dataset.h);
        timePop.querySelectorAll('[data-h]').forEach((x) => x.classList.toggle('is-sel', x === b));
        commit();
      }));
      timePop.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); draft.min = Number(b.dataset.m);
        timePop.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('is-sel', x === b));
        commit();
      }));
      timePop.querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); draft.ap = b.dataset.ap;
        timePop.querySelectorAll('[data-ap]').forEach((x) => x.classList.toggle('is-sel', x === b));
        commit();
      }));
      timePop.querySelector('[data-done]').addEventListener('click', (e) => {
        e.stopPropagation(); commit(); closePops();
      });
    }

    function togglePop(which) {
      const target = which === 'date' ? datePop : timePop;
      const opening = target.hidden;
      closePops();
      if (opening) {
        if (which === 'date') renderCalendar(); else renderTime();
        target.hidden = false;
      }
    }
    $(`c-${prefix}-date-btn`).addEventListener('click', (e) => { e.stopPropagation(); togglePop('date'); });
    $(`c-${prefix}-time-btn`).addEventListener('click', (e) => { e.stopPropagation(); togglePop('time'); });
    datePop.addEventListener('click', (e) => e.stopPropagation());
    timePop.addEventListener('click', (e) => e.stopPropagation());
    refreshLabels();
    return { getValue };
  }

  const prefStart = (prefill && prefill.startsAt && prefill.startsAt.toDate) ? prefill.startsAt.toDate() : null;
  const prefEnd = (prefill && prefill.endsAt && prefill.endsAt.toDate) ? prefill.endsAt.toDate() : null;
  const startPicker = makePicker('start', prefStart);
  const endPicker = makePicker('end', prefEnd);
  const getWhen = () => startPicker.getValue();
  const getEnd = () => endPicker.getValue();

  if (prefill) {
    $('c-ev-link').value = prefill.link || '';
    $('c-ev-loc').value = prefill.location || '';
    $('c-ev-desc').value = prefill.description || '';
  }

  // ── Flyer / cover image ──────────────────────────────────────────
  const imgState = { file: null, url: (prefill && prefill.imageUrl) || null, removed: false };
  const imgPreview = $('c-ev-image-preview');
  const imgEmpty = $('c-ev-image-empty');
  const imgRemove = $('c-ev-image-remove');
  function refreshImage() {
    const src = imgState.file ? URL.createObjectURL(imgState.file) : (imgState.removed ? null : imgState.url);
    if (src) {
      imgPreview.src = src; imgPreview.hidden = false;
      imgEmpty.hidden = true; imgRemove.hidden = false;
    } else {
      imgPreview.hidden = true; imgEmpty.hidden = false; imgRemove.hidden = true;
    }
  }
  $('c-ev-image-drop').addEventListener('click', (e) => {
    if (e.target === imgRemove) return;
    $('c-ev-image-input').click();
  });
  $('c-ev-image-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    if (f.size > 10 * 1024 * 1024) { alert('Image must be under 10MB.'); return; }
    imgState.file = f; imgState.removed = false;
    refreshImage();
  });
  imgRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    imgState.file = null; imgState.removed = true;
    $('c-ev-image-input').value = '';
    refreshImage();
  });
  refreshImage();

  const close = () => { document.removeEventListener('click', closePops); overlay.remove(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('click', closePops);
  $('c-event-close').addEventListener('click', close);
  $('c-ev-cancel').addEventListener('click', close);
  setTimeout(() => $('c-ev-title').focus(), 0);

  $('c-ev-save').addEventListener('click', async () => {
    const errEl = $('c-ev-err');
    errEl.style.display = 'none';
    const title = $('c-ev-title').value.trim();
    const when = getWhen();
    const endWhen = getEnd();
    const host = $('c-ev-host').value.trim();
    const link = $('c-ev-link').value.trim();
    const loc = $('c-ev-loc').value.trim();
    const desc = $('c-ev-desc').value.trim();

    if (!title) {
      errEl.textContent = 'Title is required.';
      errEl.style.display = 'block';
      return;
    }
    if (!when || isNaN(when.getTime())) {
      errEl.textContent = 'A start date and time are required.';
      errEl.style.display = 'block';
      return;
    }
    if (endWhen && endWhen.getTime() <= when.getTime()) {
      errEl.textContent = 'End time must be after the start time.';
      errEl.style.display = 'block';
      return;
    }

    const btn = $('c-ev-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const id = (prefill && prefill.id) || `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      let imageUrl = imgState.removed ? null : imgState.url;
      if (imgState.file) {
        btn.textContent = 'Uploading image…';
        imageUrl = await uploadEventImage(id, imgState.file);
      }
      await setDoc(doc(db, 'events', id), {
        id,
        title,
        startsAt: when,
        endsAt: endWhen || null,
        imageUrl: imageUrl || null,
        hostName: host || null,
        hostUid: state.me ? state.me.uid : null,
        link: link || null,
        location: loc || null,
        description: desc || null,
        ...(state.companyId ? { companyId: state.companyId } : {}),
        updatedAt: serverTimestamp(),
        ...(prefill ? {} : { createdAt: serverTimestamp(), createdByUid: state.me ? state.me.uid : null })
      }, { merge: true });
      close();
      await loadEvents();
      renderList();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prefill ? 'Save' : 'Create event';
      errEl.textContent = err.message || 'Could not save event.';
      errEl.style.display = 'block';
    }
  });
}

// ── Share an event to CRM contacts ─────────────────────────────────
function openShareModal(event) {
  if (document.getElementById('c-share-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'c-modal-overlay';
  overlay.id = 'c-share-modal';
  overlay.innerHTML = `
    <div class="c-modal" role="dialog" aria-modal="true">
      <button class="c-modal-close" id="c-share-close" aria-label="Close">✕</button>
      <h2 class="c-modal-title">Share to CRM</h2>
      <p class="c-modal-sub">Email "${escapeHtml(event.title || 'this event')}" to your contacts.</p>
      <div class="c-modal-body">
        <label class="c-invite-label">Send to</label>
        <label class="c-share-opt"><input type="radio" name="smode" value="all_contacts" checked> All contacts</label>
        <label class="c-share-opt"><input type="radio" name="smode" value="stages"> By stage</label>
        <div id="c-share-stages" class="c-share-stages" style="display:none;">
          ${STAGES.map((s) => `<label class="c-share-check"><input type="checkbox" data-stage="${escapeHtml(s.id)}"> ${escapeHtml(s.label)}</label>`).join('')}
        </div>
        <label class="c-invite-label" for="c-share-msg">Personal note (optional)</label>
        <textarea id="c-share-msg" class="c-ch-input" rows="3" maxlength="1000" placeholder="Add a short message to include at the top of the email…"></textarea>
        <div class="c-invite-actions">
          <button class="btn btn-primary" id="c-share-send">Send invites</button>
          <button class="btn btn-ghost" id="c-share-cancel">Cancel</button>
        </div>
        <div class="auth-error" id="c-share-err" style="display:none;"></div>
        <div class="c-share-ok" id="c-share-ok" style="display:none;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('c-share-close').addEventListener('click', close);
  $('c-share-cancel').addEventListener('click', close);
  overlay.querySelectorAll('[name="smode"]').forEach((r) => r.addEventListener('change', () => {
    $('c-share-stages').style.display = r.value === 'stages' && r.checked ? '' : 'none';
  }));

  $('c-share-send').addEventListener('click', async () => {
    const errEl = $('c-share-err');
    const okEl = $('c-share-ok');
    errEl.style.display = 'none';
    okEl.style.display = 'none';
    const mode = overlay.querySelector('[name="smode"]:checked').value;
    const filter = { mode };
    if (mode === 'stages') {
      filter.stages = Array.from(overlay.querySelectorAll('[data-stage]'))
        .filter((c) => c.checked).map((c) => c.dataset.stage);
      if (!filter.stages.length) {
        errEl.textContent = 'Pick at least one stage.';
        errEl.style.display = 'block';
        return;
      }
    }
    const btn = $('c-share-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const call = httpsCallable(functions, 'shareEventToContacts');
      const res = await call({
        companyId: state.companyId,
        eventId: event.id,
        recipientFilter: filter,
        message: $('c-share-msg').value.trim()
      });
      const r = (res && res.data) || {};
      if (!r.recipientCount) {
        okEl.textContent = 'No contacts matched — nobody to email.';
      } else {
        okEl.textContent = `Sent to ${r.acceptedCount} of ${r.recipientCount} contact${r.recipientCount === 1 ? '' : 's'}.` +
          (r.failedCount ? ` ${r.failedCount} failed.` : '');
      }
      okEl.style.display = 'block';
      btn.textContent = 'Done';
      setTimeout(close, 1800);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Send invites';
      errEl.textContent = (err && err.message) || 'Could not send.';
      errEl.style.display = 'block';
    }
  });
}

// ── Public/member registration for an event ────────────────────────
function openRegisterModal(event) {
  if (document.getElementById('c-reg-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'c-modal-overlay';
  overlay.id = 'c-reg-modal';
  const meName = state.me ? (state.me.displayName || '') : '';
  const meEmail = state.me ? (state.me.email || '') : '';
  overlay.innerHTML = `
    <div class="c-modal" role="dialog" aria-modal="true">
      <button class="c-modal-close" id="c-reg-close" aria-label="Close">✕</button>
      <h2 class="c-modal-title">Register</h2>
      <p class="c-modal-sub">${escapeHtml(event.title || 'this event')} · ${escapeHtml(fmtEventDate(event.startsAt, event.endsAt))}</p>
      <div class="c-modal-body">
        <label class="c-invite-label" for="c-reg-name">Your name</label>
        <input id="c-reg-name" class="c-ch-input" type="text" maxlength="120" value="${escapeHtml(meName)}">

        <label class="c-invite-label" for="c-reg-email">Email</label>
        <input id="c-reg-email" class="c-ch-input" type="email" maxlength="200" value="${escapeHtml(meEmail)}">

        <label class="c-invite-label" for="c-reg-phone">Phone</label>
        <input id="c-reg-phone" class="c-ch-input" type="tel" maxlength="40" placeholder="+1 (555) 000-0000">

        <label class="c-invite-label" for="c-reg-address">Address</label>
        <input id="c-reg-address" class="c-ch-input" type="text" maxlength="240" placeholder="Street, City, State">

        <label class="c-invite-label" for="c-reg-notes">Anything we should know?</label>
        <textarea id="c-reg-notes" class="c-ch-input" maxlength="800" rows="3" placeholder="Questions, accessibility needs, or other info for this event"></textarea>

        <label class="c-reg-consent">
          <input id="c-reg-consent" type="checkbox">
          <span>I want to register for this event and agree to receive updates from Kailey Brown.</span>
        </label>

        <div class="c-invite-actions">
          <button class="btn btn-primary" id="c-reg-submit" disabled>Register</button>
          <button class="btn btn-ghost" id="c-reg-cancel">Cancel</button>
        </div>
        <div class="auth-error" id="c-reg-err" style="display:none;"></div>
        <div class="c-share-ok" id="c-reg-ok" style="display:none;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('c-reg-close').addEventListener('click', close);
  $('c-reg-cancel').addEventListener('click', close);
  $('c-reg-consent').addEventListener('change', () => {
    $('c-reg-submit').disabled = !$('c-reg-consent').checked;
  });

  $('c-reg-submit').addEventListener('click', async () => {
    const errEl = $('c-reg-err');
    const okEl = $('c-reg-ok');
    errEl.style.display = 'none';
    okEl.style.display = 'none';
    const name = $('c-reg-name').value.trim();
    const email = $('c-reg-email').value.trim();
    const phone = $('c-reg-phone').value.trim();
    const address = $('c-reg-address').value.trim();
    const notes = $('c-reg-notes').value.trim();
    if (!name) { errEl.textContent = 'Please enter your name.'; errEl.style.display = 'block'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display = 'block'; return; }
    if (!$('c-reg-consent').checked) { errEl.textContent = 'Please check the box to register.'; errEl.style.display = 'block'; return; }

    const btn = $('c-reg-submit');
    btn.disabled = true;
    btn.textContent = 'Registering…';
    try {
      const call = httpsCallable(functions, 'registerForEvent');
      await call({ eventId: event.id, name, email, phone, address, notes });
      // GA4 conversion event — completed event registration.
      if (window.gtag) {
        window.gtag('event', 'event_registration', {
          event_id: event.id,
          event_title: event.title || '',
          method: state.me ? 'member' : 'public'
        });
      }
      // Reflect locally.
      if (state.me) state.myRegistrations.add(event.id);
      const ev = state.events.find((x) => x.id === event.id);
      if (ev) ev.registrationCount = Number(ev.registrationCount || 0) + 1;
      okEl.textContent = "You're registered! See you there.";
      okEl.style.display = 'block';
      btn.textContent = 'Registered ✓';
      setTimeout(() => { close(); renderList(); }, 1400);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Register';
      errEl.textContent = (err && err.message) || 'Could not register.';
      errEl.style.display = 'block';
    }
  });
}

async function openRegistrantsModal(event) {
  if (document.getElementById('c-registrants-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'c-modal-overlay';
  overlay.id = 'c-registrants-modal';
  overlay.innerHTML = `
    <div class="c-modal" role="dialog" aria-modal="true">
      <button class="c-modal-close" id="c-registrants-close" aria-label="Close">✕</button>
      <h2 class="c-modal-title">Registrants</h2>
      <p class="c-modal-sub">${escapeHtml(event.title || 'this event')}</p>
      <div class="c-modal-body">
        <div id="c-registrants-list" class="c-registrants-list">Loading…</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('c-registrants-close').addEventListener('click', close);

  try {
    const snap = await getDocs(query(collection(db, 'events', event.id, 'registrations'), orderBy('registeredAt', 'desc')));
    const rows = snap.docs.map((d) => d.data());
    const listEl = $('c-registrants-list');
    if (!rows.length) {
      listEl.innerHTML = `<div class="c-empty-body">No one has registered yet.</div>`;
      return;
    }
    listEl.innerHTML = rows.map((r) => `
      <div class="c-registrant-row">
        <div class="c-registrant-name">${escapeHtml(r.name || 'Unnamed')}</div>
        <div class="c-registrant-email">${escapeHtml(r.email || '')}</div>
        ${r.phone ? `<div class="c-registrant-email">📞 ${escapeHtml(r.phone)}</div>` : ''}
        ${r.address ? `<div class="c-registrant-email">📍 ${escapeHtml(r.address)}</div>` : ''}
        ${r.notes ? `<div class="c-registrant-meta">📝 ${escapeHtml(r.notes)}</div>` : ''}
        <div class="c-registrant-meta">${escapeHtml(r.source === 'member' ? 'Member' : 'Guest')} · ${escapeHtml(fmtRelative(r.registeredAt))}</div>
      </div>
    `).join('');
  } catch (err) {
    $('c-registrants-list').innerHTML = `<div class="auth-error">Could not load registrants: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function resolveCompanyId(uid, info) {
  let companyId = info.companyId || null;
  if (!companyId && (info.role === 'admin' || info.role === 'owner')) {
    try {
      const q = query(collection(db, 'companies'), where('adminUids', 'array-contains', uid), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) companyId = snap.docs[0].id;
    } catch (e) {}
  }
  return companyId;
}

async function main() {
  if (!firebaseReady) {
    $('gate-msg').innerHTML = `<div class="card"><div class="auth-error">Firebase is unavailable.</div></div>`;
    return;
  }
  const u = await onAuthReady();

  if (!u) {
    // Public mode — events are front-facing, so anonymous visitors can browse
    // and register. No member topbar; render a minimal public header.
    renderPublicHeader();
    bindToolbar();
    await loadEvents();
    renderList();
    return;
  }

  // Header first — it carries the Admin/Owner menu and must survive a slow or
  // failed load below.
  renderTopbarEarly({ user: u, currentPage: null });

  const info = await getRoleInfo();
  const profile = (await getUserProfile(u.uid)) || {};
  state.me = {
    uid: u.uid,
    email: u.email,
    displayName: profile.displayName || u.displayName || u.email,
    avatarUrl: profile.avatarUrl || null
  };
  state.role = info.role;

  renderTopbar({ user: state.me, profile, role: info.role, currentPage: null });

  // Owner sees the toolbar create button.
  if (state.role === 'owner') {
    const btn = $('btn-new-event');
    if (btn) btn.style.display = 'inline-flex';
  }
  bindToolbar();

  // Resolve the CRM company so admins/owner can share events to contacts.
  if (state.role === 'owner' || state.role === 'admin') {
    state.companyId = await resolveCompanyId(u.uid, info);
  }

  // Load the member's registrations so cards can show a "Registered" state.
  await loadMyRegistrations();

  await loadEvents();
  renderList();
}

function renderPublicHeader() {
  const chip = $('user-chip');
  if (chip) {
    chip.innerHTML = `<a class="back-to-main" href="/login.html?next=${encodeURIComponent('/events.html')}">Member Portal →</a>`;
  }
}

async function loadMyRegistrations() {
  state.myRegistrations = new Set();
  if (!state.me) return;
  try {
    const snap = await getDocs(collection(db, 'users', state.me.uid, 'registrations'));
    snap.docs.forEach((d) => state.myRegistrations.add(d.id));
  } catch (e) {
    console.warn('[events] my registrations load failed', e);
  }
}

main();
