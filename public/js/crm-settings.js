// CRM Settings — pipeline & stage editor. Edit stage labels/colors/probability,
// reorder, add stages, and (safely) delete unused ones. Admin/owner only.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  DEFAULT_PIPELINE_STAGES, ensureDefaultPipeline, updatePipeline,
  listOpportunities, escapeHtml
} from './crm.js';

const $ = (id) => document.getElementById(id);
const PROTECTED = new Set(DEFAULT_PIPELINE_STAGES.map((s) => s.id)); // referenced by contacts

const state = { uid: null, companyId: null, pipeline: null, stages: [], oppCountByStage: {} };

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'stage';
}

function render() {
  const content = $('crm-content');
  const stages = state.stages.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  content.innerHTML = `
    <div class="crm-section-sub">Customize your sales pipeline. Changes apply to the Opportunities board.</div>
    <div class="card" style="max-width:760px;">
      <div class="crm-field" style="margin-bottom:18px;">
        <label>Pipeline name</label>
        <input class="c-input" id="pl-name" value="${escapeHtml(state.pipeline.name || 'Sales Pipeline')}" />
      </div>
      <label class="crm-field-label" style="display:block;margin-bottom:8px;">Stages</label>
      <div id="stage-rows">
        ${stages.map((s, i) => stageRowHtml(s, i, stages.length)).join('')}
      </div>
      <button class="btn btn-ghost" id="add-stage" style="margin-top:12px;">+ Add stage</button>
      <div class="crm-save-row" style="margin-top:20px;">
        <span id="set-status" class="crm-save-status"></span>
        <button class="btn btn-primary" id="save-pipeline">Save pipeline</button>
      </div>
    </div>
  `;
  wire();
}

function stageRowHtml(s, i, total) {
  const used = state.oppCountByStage[s.id] || 0;
  const locked = PROTECTED.has(s.id) || used > 0;
  const flag = s.won ? '<span class="crm-stage-badge" style="--stage-color:#E31837">Won</span>'
    : (s.lost ? '<span class="crm-stage-badge" style="--stage-color:#C4C4C4">Lost</span>' : '');
  return `
    <div class="crm-mini-row" data-stage-row="${escapeHtml(s.id)}">
      <input type="color" class="stage-color" data-id="${escapeHtml(s.id)}" value="${escapeHtml(s.color || '#A0A0A0')}" style="width:34px;height:34px;border:none;background:none;cursor:pointer;">
      <div class="crm-mini-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input class="c-input stage-label" data-id="${escapeHtml(s.id)}" value="${escapeHtml(s.label)}" style="max-width:200px;">
        <span class="crm-mini-sub">prob</span>
        <input class="c-input stage-prob" data-id="${escapeHtml(s.id)}" type="number" min="0" max="100" value="${Math.round((s.probability || 0) * 100)}" style="max-width:74px;">
        <span class="crm-mini-sub">%</span>
        ${flag}
      </div>
      <button class="task-del" data-up="${escapeHtml(s.id)}" ${i === 0 ? 'disabled' : ''} title="Move up" style="color:var(--gray-light);">↑</button>
      <button class="task-del" data-down="${escapeHtml(s.id)}" ${i === total - 1 ? 'disabled' : ''} title="Move down" style="color:var(--gray-light);">↓</button>
      <button class="task-del" data-del="${escapeHtml(s.id)}" title="${locked ? 'In use — cannot delete' : 'Delete stage'}" ${locked ? 'disabled style="opacity:.3;"' : ''}>×</button>
    </div>`;
}

function syncFromInputs() {
  document.querySelectorAll('.stage-label').forEach((el) => {
    const s = state.stages.find((x) => x.id === el.dataset.id);
    if (s) s.label = el.value;
  });
  document.querySelectorAll('.stage-color').forEach((el) => {
    const s = state.stages.find((x) => x.id === el.dataset.id);
    if (s) s.color = el.value;
  });
  document.querySelectorAll('.stage-prob').forEach((el) => {
    const s = state.stages.find((x) => x.id === el.dataset.id);
    if (s) s.probability = Math.max(0, Math.min(100, Number(el.value) || 0)) / 100;
  });
}

function wire() {
  $('add-stage').addEventListener('click', () => {
    syncFromInputs();
    const maxOrder = state.stages.reduce((m, s) => Math.max(m, s.order || 0), 0);
    const id = slug('stage') + '-' + Math.random().toString(36).slice(2, 6);
    state.stages.push({ id, label: 'New Stage', color: '#8A8A8A', order: maxOrder + 1, probability: 0.5 });
    render();
  });
  document.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
    syncFromInputs();
    move(b.getAttribute('data-up'), -1);
  }));
  document.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => {
    syncFromInputs();
    move(b.getAttribute('data-down'), 1);
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-del');
    if (PROTECTED.has(id) || (state.oppCountByStage[id] || 0) > 0) return;
    if (!confirm('Delete this stage?')) return;
    syncFromInputs();
    state.stages = state.stages.filter((s) => s.id !== id);
    render();
  }));
  $('save-pipeline').addEventListener('click', save);
}

function move(id, dir) {
  const sorted = state.stages.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = sorted.findIndex((s) => s.id === id);
  const swap = idx + dir;
  if (swap < 0 || swap >= sorted.length) return;
  const o1 = sorted[idx].order, o2 = sorted[swap].order;
  sorted[idx].order = o2; sorted[swap].order = o1;
  render();
}

async function save() {
  syncFromInputs();
  // Normalize order to 0..n
  const ordered = state.stages.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  ordered.forEach((s, i) => { s.order = i; });
  const status = $('set-status');
  try {
    await updatePipeline(state.companyId, state.pipeline.id, {
      name: $('pl-name').value.trim() || 'Sales Pipeline',
      stages: ordered
    });
    status.textContent = 'Saved'; status.className = 'crm-save-status ok';
    state.stages = ordered;
  } catch (e) {
    status.textContent = 'Error: ' + (e.message || e); status.className = 'crm-save-status err';
  }
}

async function main() {
  if (!firebaseReady) return;
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/crm-settings.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid;

  const content = renderCrmShell({ active: 'settings', title: 'CRM Settings', user: u, role: info.role });
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
  content.innerHTML = `<div class="crm-section-sub">Loading pipeline…</div>`;

  state.pipeline = await ensureDefaultPipeline(companyId);
  state.stages = (state.pipeline.stages || DEFAULT_PIPELINE_STAGES).map((s) => ({ ...s }));
  const opps = await listOpportunities(companyId, { pipelineId: state.pipeline.id });
  state.oppCountByStage = {};
  opps.forEach((o) => { state.oppCountByStage[o.stageId] = (state.oppCountByStage[o.stageId] || 0) + 1; });
  render();
}

main();
