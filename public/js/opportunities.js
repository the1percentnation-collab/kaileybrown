// Opportunities (deals) board — GHL-style pipeline carrying revenue.
// Columns = pipeline stages; each shows count + value total. Drag a deal to
// move stages (won/lost stages flip the deal status). Admin/owner only.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  ensureDefaultPipeline, listOpportunities, createOpportunity, setOppStage,
  listContacts, listCompanyAdmins, escapeHtml, fmtMoney, fmtDate
} from './crm.js';

const $ = (id) => document.getElementById(id);

const state = {
  uid: null, role: null, companyId: null,
  pipeline: null, opps: [], contacts: [], admins: []
};

function stageById(id) {
  return (state.pipeline.stages || []).find((s) => s.id === id) || null;
}

function forecast() {
  let pipelineValue = 0, weighted = 0, won = 0;
  state.opps.forEach((o) => {
    if (o.status === 'won') { won += Number(o.amountPaid || o.value || 0); return; }
    if (o.status === 'lost') return;
    const v = Number(o.value || 0);
    pipelineValue += v;
    const st = stageById(o.stageId);
    weighted += v * (st && typeof st.probability === 'number' ? st.probability : 0.3);
  });
  return { pipelineValue, weighted, won };
}

function oppCardHtml(o) {
  const sub = [];
  if (o.contactName) sub.push(escapeHtml(o.contactName));
  if (o.expectedCloseAt) sub.push('close ' + fmtDate(o.expectedCloseAt));
  return `
    <a class="opp-card" href="/contact.html?id=${encodeURIComponent(o.contactId || '')}"
       draggable="true" data-opp-id="${o.id}" data-stage="${escapeHtml(o.stageId)}"
       data-contact="${escapeHtml(o.contactId || '')}">
      <div class="opp-card-title">${escapeHtml(o.title)}</div>
      <div class="opp-card-value">${fmtMoney(o.value)}</div>
      ${sub.length ? `<div class="opp-card-sub">${sub.join(' · ')}</div>` : ''}
    </a>`;
}

function render() {
  const stages = (state.pipeline.stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const byStage = {};
  stages.forEach((s) => { byStage[s.id] = []; });
  state.opps.forEach((o) => {
    const sid = byStage[o.stageId] ? o.stageId : stages[0].id;
    byStage[sid].push(o);
  });
  const f = forecast();

  const content = $('crm-content');
  content.innerHTML = `
    <div class="crm-page-head">
      <button class="btn btn-primary" id="btn-new-deal">+ New Deal</button>
      <div class="crm-toolbar-spacer"></div>
    </div>
    <div class="opp-forecast">
      <div class="opp-forecast-item"><span class="crm-widget-label">Open pipeline</span><div class="opp-forecast-val">${fmtMoney(f.pipelineValue)}</div></div>
      <div class="opp-forecast-item"><span class="crm-widget-label">Weighted forecast</span><div class="opp-forecast-val">${fmtMoney(f.weighted)}</div></div>
      <div class="opp-forecast-item"><span class="crm-widget-label">Won (revenue)</span><div class="opp-forecast-val">${fmtMoney(f.won)}</div></div>
    </div>
    <div class="opp-board">
      ${stages.map((s) => {
        const list = byStage[s.id] || [];
        const total = list.reduce((sum, o) => sum + Number(o.value || 0), 0);
        return `
          <div class="opp-col">
            <div class="opp-col-head">
              <div class="opp-col-title-row">
                <span class="crm-dot" style="background:${s.color}"></span>
                <span class="opp-col-title">${escapeHtml(s.label)}</span>
                <span class="opp-col-count">${list.length}</span>
              </div>
              <div class="opp-col-total">${fmtMoney(total)}</div>
            </div>
            <div class="opp-col-body" data-drop-stage="${s.id}">
              ${list.map(oppCardHtml).join('') || '<div class="opp-col-empty">—</div>'}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

  $('btn-new-deal').addEventListener('click', openNewDealModal);
  wireDragDrop();
}

function wireDragDrop() {
  document.querySelectorAll('.opp-card').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        oppId: el.dataset.oppId, fromStage: el.dataset.stage, contactId: el.dataset.contact
      }));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  document.querySelectorAll('[data-drop-stage]').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('crm-col-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('crm-col-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('crm-col-over');
      let p = null;
      try { p = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); } catch (_) {}
      if (!p || !p.oppId) return;
      const toStageId = col.getAttribute('data-drop-stage');
      if (toStageId === p.fromStage) return;
      const st = stageById(toStageId);
      // Optimistic
      const o = state.opps.find((x) => x.id === p.oppId);
      if (o) { o.stageId = toStageId; o.status = st && st.won ? 'won' : (st && st.lost ? 'lost' : 'open'); }
      render();
      try {
        await setOppStage(state.companyId, p.oppId, {
          toStageId, fromStageId: p.fromStage, toStageLabel: st ? st.label : toStageId,
          won: !!(st && st.won), lost: !!(st && st.lost), contactId: p.contactId || (o && o.contactId)
        });
        await reload();
      } catch (err) {
        alert('Could not move deal: ' + (err.message || err));
        await reload();
      }
    });
  });
}

function openNewDealModal() {
  const root = $('modal-root');
  const stages = (state.pipeline.stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  root.innerHTML = `
    <div class="crm-modal-backdrop" id="modal-bd">
      <div class="crm-modal auth-card">
        <h1>New <span>Deal</span></h1>
        <form id="deal-form" class="crm-form">
          <div class="crm-form-row">
            <label>Deal title *</label>
            <input class="c-input" id="d-title" required placeholder="Acme — Annual plan" />
          </div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row">
              <label>Value ($)</label>
              <input class="c-input" id="d-value" type="number" min="0" step="1" placeholder="5000" />
            </div>
            <div class="crm-form-row">
              <label>Expected close</label>
              <input class="c-input" id="d-close" type="date" />
            </div>
          </div>
          <div class="crm-form-row-grid">
            <div class="crm-form-row">
              <label>Stage</label>
              <select class="c-input crm-select" id="d-stage">
                ${stages.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('')}
              </select>
            </div>
            <div class="crm-form-row">
              <label>Owner</label>
              <select class="c-input crm-select" id="d-owner"></select>
            </div>
          </div>
          <div class="crm-form-row">
            <label>Contact</label>
            <select class="c-input crm-select" id="d-contact">
              <option value="">— none —</option>
              ${state.contacts.map((c) => `<option value="${c.id}">${escapeHtml(c.name || 'Unnamed')}${c.companyName ? ' · ' + escapeHtml(c.companyName) : ''}</option>`).join('')}
            </select>
          </div>
          <div id="d-err" class="auth-error" style="display:none;"></div>
          <div class="crm-modal-actions">
            <button type="button" class="btn btn-ghost" id="d-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create deal</button>
          </div>
        </form>
      </div>
    </div>
  `;
  $('d-owner').innerHTML = [
    `<option value="${state.uid}">Me</option>`,
    ...state.admins.filter((a) => a.uid !== state.uid).map((a) => `<option value="${a.uid}">${escapeHtml(a.displayName || a.email || a.uid)}</option>`)
  ].join('');

  const close = () => { root.innerHTML = ''; };
  $('d-cancel').addEventListener('click', close);
  $('modal-bd').addEventListener('click', (e) => { if (e.target.id === 'modal-bd') close(); });

  $('deal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('d-err');
    errEl.style.display = 'none';
    try {
      const contactId = $('d-contact').value || null;
      const contact = state.contacts.find((c) => c.id === contactId);
      const closeStr = $('d-close').value;
      await createOpportunity(state.companyId, {
        title: $('d-title').value,
        value: $('d-value').value,
        expectedCloseAt: closeStr ? new Date(closeStr + 'T12:00:00') : null,
        stageId: $('d-stage').value,
        ownerUid: $('d-owner').value,
        pipelineId: state.pipeline.id,
        contactId,
        contactName: contact ? (contact.name || null) : null,
        source: contact ? (contact.source || null) : null
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
  state.opps = await listOpportunities(state.companyId, { pipelineId: state.pipeline.id });
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
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/opportunities.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid; state.role = info.role;

  const content = renderCrmShell({ active: 'opportunities', title: 'Opportunities', user: u, role: info.role });
  const companyId = await resolveCompanyId(u.uid, info);
  if (!companyId) {
    content.innerHTML = `<div class="card"><div class="auth-error">You are not an admin of any company yet. Use /owner.html.</div></div>`;
    return;
  }
  state.companyId = companyId;
  content.innerHTML = `<div class="crm-section-sub">Loading pipeline…</div>`;

  state.pipeline = await ensureDefaultPipeline(companyId);
  [state.contacts, state.admins] = await Promise.all([
    listContacts(companyId), listCompanyAdmins(companyId)
  ]);
  await reload();
}

main();
