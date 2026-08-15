// Tasks page — Today / Overdue / Upcoming / No date buckets, with a "Mine"
// filter and complete/reopen/delete. Admin/owner only.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  listTasks, createTask, completeTask, reopenTask, deleteTask,
  listContacts, listCompanyAdmins, escapeHtml, fmtDate, toDate
} from './crm.js';

const $ = (id) => document.getElementById(id);

const state = {
  uid: null, role: null, companyId: null,
  tasks: [], contacts: [], admins: [],
  filterMine: false, showDone: false
};

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d; }

function bucketFor(t) {
  if (t.status === 'done') return 'done';
  const due = toDate(t.dueAt);
  if (!due) return 'nodate';
  if (due < startOfToday()) return 'overdue';
  if (due <= endOfToday()) return 'today';
  return 'upcoming';
}

function assigneeLabel(uid) {
  if (uid === state.uid) return 'Me';
  const a = state.admins.find((x) => x.uid === uid);
  return a ? (a.displayName || a.email || uid.slice(0, 6)) : '—';
}

function taskRowHtml(t) {
  const overdue = bucketFor(t) === 'overdue';
  const meta = [];
  meta.push(`<span class="${overdue ? 'task-due-overdue' : ''}">${t.dueAt ? 'Due ' + fmtDate(t.dueAt) : 'No due date'}</span>`);
  if (t.contactName) meta.push(escapeHtml(t.contactName));
  meta.push(assigneeLabel(t.assigneeUid));
  const checked = t.status === 'done';
  return `
    <div class="task-row ${checked ? 'done' : ''} ${t.priority === 'high' ? 'task-priority-high' : ''}" data-task="${t.id}">
      <button class="task-check ${checked ? 'checked' : ''}" data-toggle="${t.id}" aria-label="Toggle">${checked ? '✓' : ''}</button>
      <div class="task-main">
        ${t.contactId
          ? `<a class="task-title" href="/contact.html?id=${encodeURIComponent(t.contactId)}" style="text-decoration:none;">${escapeHtml(t.title)}</a>`
          : `<div class="task-title">${escapeHtml(t.title)}</div>`}
        <div class="task-meta">${meta.join('<span>·</span>')}</div>
      </div>
      <button class="task-del" data-del="${t.id}" title="Delete">×</button>
    </div>`;
}

function bucketHtml(title, list) {
  return `
    <div class="task-bucket">
      <div class="task-bucket-head">
        <span class="task-bucket-title">${title}</span>
        <span class="task-bucket-count">${list.length}</span>
      </div>
      <div class="task-list">
        ${list.length ? list.map(taskRowHtml).join('') : '<div class="task-empty">Nothing here.</div>'}
      </div>
    </div>`;
}

function render() {
  let rows = state.tasks.slice();
  if (state.filterMine) rows = rows.filter((t) => t.assigneeUid === state.uid);

  const buckets = { overdue: [], today: [], upcoming: [], nodate: [], done: [] };
  rows.forEach((t) => { buckets[bucketFor(t)].push(t); });
  const sortByDue = (a, b) => (toDate(a.dueAt)?.getTime() || Infinity) - (toDate(b.dueAt)?.getTime() || Infinity);
  buckets.overdue.sort(sortByDue); buckets.today.sort(sortByDue); buckets.upcoming.sort(sortByDue);

  const content = $('crm-content');
  content.innerHTML = `
    <div class="crm-page-head">
      <button class="btn btn-primary" id="btn-new-task">+ New Task</button>
      <div class="crm-chip-row">
        <button class="crm-chip ${!state.filterMine ? 'active' : ''}" id="f-all">All</button>
        <button class="crm-chip ${state.filterMine ? 'active' : ''}" id="f-mine">Mine</button>
      </div>
      <div class="crm-toolbar-spacer"></div>
      <button class="crm-chip ${state.showDone ? 'active' : ''}" id="f-done">Show completed</button>
    </div>
    ${bucketHtml('Overdue', buckets.overdue)}
    ${bucketHtml('Today', buckets.today)}
    ${bucketHtml('Upcoming', buckets.upcoming)}
    ${bucketHtml('No due date', buckets.nodate)}
    ${state.showDone ? bucketHtml('Completed', buckets.done.slice(0, 50)) : ''}
  `;

  $('btn-new-task').addEventListener('click', openNewTaskModal);
  $('f-all').addEventListener('click', () => { state.filterMine = false; render(); });
  $('f-mine').addEventListener('click', () => { state.filterMine = true; render(); });
  $('f-done').addEventListener('click', () => { state.showDone = !state.showDone; render(); });

  content.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-toggle');
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    try {
      if (t.status === 'done') await reopenTask(state.companyId, id);
      else await completeTask(state.companyId, id, { contactId: t.contactId, title: t.title });
      await reload();
    } catch (e) { alert('Could not update task: ' + (e.message || e)); }
  }));
  content.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-del');
    if (!confirm('Delete this task?')) return;
    try { await deleteTask(state.companyId, id); await reload(); }
    catch (e) { alert('Could not delete: ' + (e.message || e)); }
  }));
}

function openNewTaskModal() {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal auth-card">
        <h1>New <span>Task</span></h1>
        <form id="task-form" class="crm-form">
          <div class="crm-form-row">
            <label>Title *</label>
            <input class="c-input" id="t-title" required placeholder="Follow up with Jane" />
          </div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row">
              <label>Due</label>
              <input class="c-input" id="t-due" type="datetime-local" />
            </div>
            <div class="crm-form-row">
              <label>Priority</label>
              <select class="c-input crm-select" id="t-priority">
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row">
              <label>Assignee</label>
              <select class="c-input crm-select" id="t-assignee"></select>
            </div>
            <div class="crm-form-row">
              <label>Contact</label>
              <select class="c-input crm-select" id="t-contact">
                <option value="">— none —</option>
                ${state.contacts.map((c) => `<option value="${c.id}">${escapeHtml(c.name || 'Unnamed')}</option>`).join('')}
              </select>
            </div>
          </div>
          <div id="t-err" class="auth-error" style="display:none;"></div>
          <div class="crm-modal-actions">
            <button type="button" class="btn btn-ghost" id="t-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create task</button>
          </div>
        </form>
      </div>
    </div>
  `;
  $('t-assignee').innerHTML = [
    `<option value="${state.uid}">Me</option>`,
    ...state.admins.filter((a) => a.uid !== state.uid).map((a) => `<option value="${a.uid}">${escapeHtml(a.displayName || a.email || a.uid)}</option>`)
  ].join('');

  const close = () => { root.innerHTML = ''; };
  $('t-cancel').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });

  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('t-err');
    errEl.style.display = 'none';
    try {
      const contactId = $('t-contact').value || null;
      const contact = state.contacts.find((c) => c.id === contactId);
      const dueStr = $('t-due').value;
      await createTask(state.companyId, {
        title: $('t-title').value,
        dueAt: dueStr ? new Date(dueStr) : null,
        priority: $('t-priority').value,
        assigneeUid: $('t-assignee').value,
        contactId,
        contactName: contact ? (contact.name || null) : null
      });
      close();
      await reload();
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.style.display = '';
    }
  });
}

async function reload() {
  state.tasks = await listTasks(state.companyId, {});
  render();
}

async function resolveCompanyId(uid, info) {
  let companyId = new URLSearchParams(location.search).get('companyId') || info.companyId || null;
  if (!companyId && info.isAdmin) {
    try {
      const q = query(collection(db, 'companies'), where('adminUids', 'array-contains', uid), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) companyId = snap.docs[0].id;
    } catch (e) {}
  }
  return companyId;
}

async function main() {
  if (!firebaseReady) return;
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/tasks.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid; state.role = info.role;

  const content = renderCrmShell({ active: 'tasks', title: 'Tasks', user: u, role: info.role });
  const companyId = await resolveCompanyId(u.uid, info);
  if (!companyId) {
    content.innerHTML = `<div class="card"><div class="auth-error">You are not an admin of any company yet. Use /owner.html.</div></div>`;
    return;
  }
  state.companyId = companyId;
  content.innerHTML = `<div class="crm-section-sub">Loading tasks…</div>`;

  [state.contacts, state.admins] = await Promise.all([
    listContacts(companyId), listCompanyAdmins(companyId)
  ]);
  await reload();
}

main();
