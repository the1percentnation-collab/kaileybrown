// Conversations — SMS inbox (left) + thread (right). Sending goes through the
// sendSms callable (Twilio). Admin/owner only. Works once Twilio is configured;
// until then the list is empty and sending shows a "not configured" message.

import { db, firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { getRoleInfo } from './roles.js';
import { renderCrmShell } from './crm-shell.js';
import { collection, getDocs, query, where, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  listConversations, listMessages, sendSms, markConversationRead,
  listContacts, escapeHtml, fmtDateTime
} from './crm.js';

const $ = (id) => document.getElementById(id);
const state = { uid: null, companyId: null, convs: [], contacts: {}, activeId: null, messages: [] };

function contactName(contactId, phone) {
  const c = state.contacts[contactId];
  return (c && c.name) || phone || 'Unknown';
}

function renderShellLayout() {
  $('crm-content').innerHTML = `
    <div class="sms-wrap">
      <div class="sms-list" id="sms-list"></div>
      <div class="sms-thread" id="sms-thread">
        <div class="crm-subpanel-empty" style="margin:auto;">Select a conversation.</div>
      </div>
    </div>`;
}

function renderList() {
  const host = $('sms-list');
  if (!state.convs.length) {
    host.innerHTML = `<div class="crm-subpanel-empty" style="padding:16px;">No conversations yet. Inbound texts and SMS you send appear here.</div>`;
    return;
  }
  host.innerHTML = state.convs.map((c) => `
    <button class="sms-list-item ${c.id === state.activeId ? 'active' : ''}" data-conv="${escapeHtml(c.id)}">
      <div class="sms-list-top">
        <span class="sms-list-name">${escapeHtml(contactName(c.contactId, c.contactPhone))}</span>
        ${c.unreadCount ? `<span class="sms-unread">${c.unreadCount}</span>` : ''}
      </div>
      <div class="sms-list-preview">${c.lastDirection === 'out' ? 'You: ' : ''}${escapeHtml((c.lastMessageText || '').slice(0, 60))}</div>
    </button>`).join('');
  host.querySelectorAll('[data-conv]').forEach((b) => b.addEventListener('click', () => openThread(b.getAttribute('data-conv'))));
}

async function openThread(convId) {
  state.activeId = convId;
  renderList();
  const conv = state.convs.find((c) => c.id === convId);
  const host = $('sms-thread');
  host.innerHTML = `<div class="crm-subpanel-empty" style="margin:auto;">Loading…</div>`;
  state.messages = await listMessages(state.companyId, convId);
  if (conv && conv.unreadCount) { markConversationRead(state.companyId, convId); conv.unreadCount = 0; renderList(); }

  host.innerHTML = `
    <div class="sms-thread-head">
      <a href="/contact.html?id=${encodeURIComponent(convId)}" class="sms-thread-name">${escapeHtml(contactName(convId, conv && conv.contactPhone))}</a>
      <span class="crm-mini-sub">${escapeHtml((conv && conv.contactPhone) || '')}</span>
    </div>
    <div class="sms-messages" id="sms-messages">
      ${state.messages.length ? state.messages.map((m) => `
        <div class="sms-bubble sms-${m.direction === 'out' ? 'out' : 'in'}">
          <div class="sms-bubble-body">${escapeHtml(m.body || '')}</div>
          <div class="sms-bubble-meta">${fmtDateTime(m.createdAt)}${m.status ? ' · ' + escapeHtml(m.status) : ''}</div>
        </div>`).join('') : '<div class="crm-subpanel-empty">No messages yet.</div>'}
    </div>
    <form class="sms-composer" id="sms-composer">
      <input class="c-input" id="sms-input" placeholder="Type a text…" autocomplete="off" />
      <button class="btn btn-primary" type="submit" id="sms-send">Send</button>
    </form>
    <div id="sms-err" class="auth-error" style="display:none;margin-top:8px;"></div>`;

  const msgs = $('sms-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  $('sms-composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('sms-input');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('sms-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    $('sms-err').style.display = 'none';
    try {
      await sendSms(state.companyId, convId, text);
      input.value = '';
      await refresh();
      await openThread(convId);
    } catch (err) {
      $('sms-err').textContent = err.message || String(err);
      $('sms-err').style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Send';
    }
  });
}

async function refresh() {
  state.convs = await listConversations(state.companyId);
  renderList();
}

async function main() {
  if (!firebaseReady) return;
  const u = await onAuthReady();
  if (!u) { location.replace('/login.html?next=' + encodeURIComponent('/conversations.html')); return; }
  const info = await getRoleInfo(true);
  if (!info.isAdmin) { location.replace('/index.html'); return; }
  state.uid = u.uid;

  const content = renderCrmShell({ active: 'conversations', title: 'Conversations', user: u, role: info.role });
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
  content.innerHTML = `<div class="crm-section-sub">Loading conversations…</div>`;

  const contacts = await listContacts(companyId);
  contacts.forEach((c) => { state.contacts[c.id] = c; });
  renderShellLayout();
  await refresh();

  // Deep-link to a contact's thread: /conversations.html?contact=ID
  const target = new URLSearchParams(location.search).get('contact');
  if (target) openThread(target);
}

main();
