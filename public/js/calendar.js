// Calendar — month grid of appointments + upcoming list + booking modal.
// Admin/owner only.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  listAppointments, createAppointment, setAppointmentStatus, deleteAppointment,
  listContacts, listCompanyAdmins, escapeHtml, toDate
} from './crm.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const state = {
  uid: null, companyId: null, appts: [], contacts: [], admins: [],
  view: new Date() // first-of-month anchor
};

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtTime(d) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

function render() {
  const v = state.view;
  const year = v.getFullYear(), month = v.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // bucket appts by day-of-month for this month
  const byDay = {};
  state.appts.forEach((a) => {
    const d = toDate(a.startAt);
    if (d && d.getFullYear() === year && d.getMonth() === month) {
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push({ ...a, _d: d });
    }
  });
  Object.values(byDay).forEach((list) => list.sort((x, y) => x._d - y._d));

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell cal-cell-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = sameDay(new Date(year, month, day), today);
    const list = byDay[day] || [];
    cells.push(`
      <div class="cal-cell ${isToday ? 'cal-today' : ''}" data-day="${day}">
        <div class="cal-daynum">${day}</div>
        ${list.slice(0, 3).map((a) => `
          <button class="cal-appt" data-appt="${a.id}" title="${escapeHtml(a.title)}" style="--stage-color:${a.status === 'completed' ? '#56D4A8' : (a.status === 'canceled' || a.status === 'noshow' ? '#8B4A4A' : '#C8102E')}">
            ${fmtTime(a._d)} ${escapeHtml(a.title)}
          </button>`).join('')}
        ${list.length > 3 ? `<div class="cal-more">+${list.length - 3} more</div>` : ''}
      </div>`);
  }

  const upcoming = state.appts
    .map((a) => ({ ...a, _d: toDate(a.startAt) }))
    .filter((a) => a._d && a._d >= new Date(today.getFullYear(), today.getMonth(), today.getDate()) && a.status === 'scheduled')
    .sort((a, b) => a._d - b._d).slice(0, 8);

  const content = $('crm-content');
  content.innerHTML = `
    <div class="crm-page-head">
      <button class="btn btn-primary" id="btn-new-appt">+ New Appointment</button>
      <div class="crm-toolbar-spacer"></div>
      <button class="crm-chip" id="cal-prev">‹</button>
      <button class="crm-chip" id="cal-today">Today</button>
      <button class="crm-chip" id="cal-next">›</button>
      <span class="task-bucket-title" style="margin-left:8px;">${MONTHS[month]} ${year}</span>
    </div>
    <div class="cal-grid-head">${DOW.map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>

    <div class="task-bucket" style="margin-top:24px;">
      <div class="task-bucket-head"><span class="task-bucket-title">Upcoming</span><span class="task-bucket-count">${upcoming.length}</span></div>
      <div class="task-list">
        ${upcoming.length ? upcoming.map((a) => `
          <div class="crm-mini-row">
            <div class="crm-mini-main">
              <div class="crm-mini-title">${escapeHtml(a.title)}</div>
              <div class="crm-mini-sub">${a._d.toLocaleString()}${a.contactName ? ' · ' + escapeHtml(a.contactName) : ''}${a.location ? ' · ' + escapeHtml(a.location) : ''}</div>
            </div>
            <button class="crm-chip" data-appt="${a.id}">Manage</button>
          </div>`).join('') : '<div class="task-empty">No upcoming appointments.</div>'}
      </div>
    </div>
  `;

  $('btn-new-appt').addEventListener('click', () => openApptModal());
  $('cal-prev').addEventListener('click', () => { state.view = new Date(year, month - 1, 1); render(); });
  $('cal-next').addEventListener('click', () => { state.view = new Date(year, month + 1, 1); render(); });
  $('cal-today').addEventListener('click', () => { state.view = new Date(); render(); });
  content.querySelectorAll('[data-appt]').forEach((b) => b.addEventListener('click', () => {
    const a = state.appts.find((x) => x.id === b.getAttribute('data-appt'));
    if (a) openApptModal(a);
  }));
  content.querySelectorAll('[data-day]').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.closest('[data-appt]')) return;
    const day = Number(c.getAttribute('data-day'));
    openApptModal(null, new Date(year, month, day, 9, 0));
  }));
}

function openApptModal(appt, prefillDate) {
  const root = $('modal-root');
  const editing = !!appt;
  const d = appt ? toDate(appt.startAt) : (prefillDate || new Date());
  const localVal = d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal auth-card">
        <h1>${editing ? 'Edit' : 'New'} <span>Appointment</span></h1>
        <form id="ap-form" class="crm-form">
          <div class="crm-form-row"><label>Title *</label>
            <input class="c-input" id="ap-title" required value="${editing ? escapeHtml(appt.title) : ''}" placeholder="Strategy call" /></div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row"><label>Start *</label>
              <input class="c-input" id="ap-start" type="datetime-local" required value="${localVal}" /></div>
            <div class="crm-form-row"><label>Duration (min)</label>
              <input class="c-input" id="ap-dur" type="number" min="5" step="5" value="${editing ? (appt.durationMin || 30) : 30}" /></div>
          </div>
          <div class="crm-form-row"><label>Location / link</label>
            <input class="c-input" id="ap-loc" value="${editing ? escapeHtml(appt.location || '') : ''}" placeholder="Zoom link, address, or phone" /></div>
          <div class="crm-form-row"><label>Contact</label>
            <select class="c-input crm-select" id="ap-contact">
              <option value="">— none —</option>
              ${state.contacts.map((c) => `<option value="${c.id}" ${editing && appt.contactId === c.id ? 'selected' : ''}>${escapeHtml(c.name || 'Unnamed')}</option>`).join('')}
            </select></div>
          <div id="ap-err" class="auth-error" style="display:none;"></div>
          <div class="crm-modal-actions">
            ${editing ? `<button type="button" class="btn btn-ghost" id="ap-del" style="margin-right:auto;">Delete</button>
              <button type="button" class="btn btn-ghost" id="ap-complete">Mark done</button>
              <button type="button" class="btn btn-ghost" id="ap-cancel-appt">Cancel appt</button>` : ''}
            <button type="button" class="btn btn-ghost" id="ap-close">Close</button>
            <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Book'}</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('ap-close').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });

  if (editing) {
    $('ap-del').addEventListener('click', async () => {
      if (!confirm('Delete this appointment?')) return;
      await deleteAppointment(state.companyId, appt.id); close(); await reload();
    });
    $('ap-complete').addEventListener('click', async () => {
      await setAppointmentStatus(state.companyId, appt.id, 'completed', { contactId: appt.contactId }); close(); await reload();
    });
    $('ap-cancel-appt').addEventListener('click', async () => {
      await setAppointmentStatus(state.companyId, appt.id, 'canceled', { contactId: appt.contactId }); close(); await reload();
    });
  }

  $('ap-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const startStr = $('ap-start').value;
      const contactId = $('ap-contact').value || null;
      const contact = state.contacts.find((c) => c.id === contactId);
      const payload = {
        title: $('ap-title').value,
        startAt: startStr ? new Date(startStr) : null,
        durationMin: $('ap-dur').value,
        location: $('ap-loc').value || null,
        contactId, contactName: contact ? (contact.name || null) : null
      };
      if (editing) {
        const { updateAppointment } = await import('./crm.js');
        await updateAppointment(state.companyId, appt.id, payload);
      } else {
        await createAppointment(state.companyId, payload);
      }
      close(); await reload();
    } catch (err) {
      $('ap-err').textContent = err.message || String(err);
      $('ap-err').style.display = '';
    }
  });
}

async function reload() {
  state.appts = await listAppointments(state.companyId, {});
  render();
}

async function main() {
  if (!firebaseReady) return;
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/calendar.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid;

  const content = renderCrmShell({ active: 'calendar', title: 'Calendar', user: u, role: info.role });
  let companyId = new URLSearchParams(location.search).get('companyId') || info.companyId || null;
  if (!companyId && info.isAdmin) {
    try {
      const q = query(collection(db, 'companies'), where('adminUids', 'array-contains', u.uid), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) companyId = snap.docs[0].id;
    } catch (e) {}
  }
  if (!companyId) {
    content.innerHTML = `<div class="card"><div class="auth-error">You are not an admin of any company yet. Use /owner.html.</div></div>`;
    return;
  }
  state.companyId = companyId;
  content.innerHTML = `<div class="crm-section-sub">Loading calendar…</div>`;
  [state.contacts, state.admins] = await Promise.all([listContacts(companyId), listCompanyAdmins(companyId)]);
  await reload();
}

main();
