// CRM Dashboard — macro sales view. Computes widgets client-side from the
// company's contacts / opportunities / tasks. Deep reporting is stubbed.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  ensureDefaultPipeline, listOpportunities, listTasks, listContacts,
  escapeHtml, fmtMoney, fmtDate, toDate
} from './crm.js';

const $ = (id) => document.getElementById(id);
const state = { uid: null, companyId: null };

function startOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d; }

function widget(label, value, sub, opts = {}) {
  return `<div class="crm-widget ${opts.accent ? 'crm-widget-accent' : ''} ${opts.soon ? 'crm-widget-soon' : ''}">
    <div class="crm-widget-label">${escapeHtml(label)}</div>
    <div class="crm-widget-value">${value}</div>
    ${sub ? `<div class="crm-widget-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

async function main() {
  if (!firebaseReady) return;
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/crm-dashboard.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid;

  const content = renderCrmShell({ active: 'dashboard', title: 'Dashboard', user: u, role: info.role });

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
  content.innerHTML = `<div class="crm-section-sub">Crunching numbers…</div>`;

  await ensureDefaultPipeline(companyId);
  const [opps, tasks, contacts] = await Promise.all([
    listOpportunities(companyId, {}), listTasks(companyId, {}), listContacts(companyId)
  ]);

  // Pipeline metrics
  let openValue = 0, weighted = 0, wonAll = 0, wonMonth = 0, wonCount = 0, lostCount = 0;
  const som = startOfMonth();
  opps.forEach((o) => {
    if (o.status === 'won') {
      const amt = Number(o.amountPaid || o.value || 0);
      wonAll += amt; wonCount++;
      const wd = toDate(o.wonAt);
      if (wd && wd >= som) wonMonth += amt;
    } else if (o.status === 'lost') { lostCount++; }
    else {
      openValue += Number(o.value || 0);
      weighted += Number(o.value || 0) * 0.4;
    }
  });
  const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;

  // Tasks
  let dueToday = 0, overdue = 0;
  tasks.forEach((t) => {
    if (t.status === 'done') return;
    const d = toDate(t.dueAt);
    if (!d) return;
    if (d < startOfToday()) overdue++;
    else if (d <= endOfToday()) dueToday++;
  });

  content.innerHTML = `
    <div class="crm-section-sub">Your sales at a glance — pipeline, revenue, and what needs attention today.</div>
    <div class="crm-widgets">
      ${widget('Open pipeline', fmtMoney(openValue), `${opps.filter((o) => o.status === 'open').length} open deals`, { accent: true })}
      ${widget('Weighted forecast', fmtMoney(weighted), 'probability-adjusted')}
      ${widget('Revenue this month', fmtMoney(wonMonth), `${fmtMoney(wonAll)} all-time`)}
      ${widget('Win rate', winRate + '%', `${wonCount} won · ${lostCount} lost`)}
      ${widget('Contacts', String(contacts.length), 'total in CRM')}
      ${widget('Tasks today', String(dueToday), overdue ? `${overdue} overdue` : 'nothing overdue')}
    </div>

    <div class="crm-widgets">
      ${widget('Reports', 'Coming soon', '', { soon: true })}
      ${widget('Lead source ROI', 'Coming soon', '', { soon: true })}
      ${widget('Rep leaderboard', 'Coming soon', '', { soon: true })}
      ${widget('Conversion funnel', 'Coming soon', '', { soon: true })}
    </div>
  `;
}

main();
