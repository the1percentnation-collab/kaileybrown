// Members directory — cards showing avatar, name, bio preview, progress %.

import { firebaseReady } from './firebase.js';
import { onAuthReady } from './auth.js';
import { renderTopbar } from './topbar.js';
import { getRoleInfo } from './roles.js';
import { listMembers, getUserProfile, avatarHtml, escapeHtml } from './community.js';

const $ = (id) => document.getElementById(id);


function memberCardHtml(m) {
  // completedCount may come from members subcollection digest OR from the user doc (owner view).
  const cc = typeof m.completedCount === 'number' ? m.completedCount : 0;
  const role = m.role || null;
  const roleBadge = role === 'owner'
    ? `<span class="c-role-badge c-role-owner">Owner</span>`
    : role === 'admin' ? `<span class="c-role-badge c-role-admin">Admin</span>` : '';
  const bio = m.bio ? escapeHtml(m.bio).slice(0, 120) : 'No bio yet.';
  return `
    <a class="c-member-card" href="/profile.html?uid=${encodeURIComponent(m.uid)}">
      ${avatarHtml(m, 56)}
      <div class="c-member-name">${escapeHtml(m.displayName || m.email || 'Member')} ${roleBadge}</div>
      <div class="c-member-bio">${bio}</div>
      <div class="c-member-progress">
        <span class="c-progress-pct">${cc} lesson${cc === 1 ? '' : 's'} completed</span>
      </div>
    </a>
  `;
}

async function main() {
  if (!firebaseReady) {
    $('grid').innerHTML = `<div class="auth-error">Firebase is unavailable.</div>`;
    return;
  }
  const u = await onAuthReady();
  if (!u) {
    location.replace('/login.html?next=' + encodeURIComponent('/members.html'));
    return;
  }
  const info = await getRoleInfo();
  const profile = (await getUserProfile(u.uid)) || {};
  const me = {
    uid: u.uid,
    email: u.email,
    displayName: profile.displayName || u.displayName || u.email,
    avatarUrl: profile.avatarUrl || null
  };
  renderTopbar({ user: me, profile, role: info.role, currentPage: 'members' });

  const members = await listMembers({ role: info.role, companyId: info.companyId });
  if (!members.length) {
    $('grid').innerHTML = `
      <div class="c-empty">
        <div class="c-empty-title">No members yet</div>
        <p>Invite teammates from the admin console to see them here.</p>
      </div>`;
    return;
  }

  // Owner: enrich by fetching user docs individually to pull bio/avatar.
  // Company/members subcollection already has displayName/avatar digest; for
  // owner path (all users) we already have full doc data.
  if (info.role !== 'owner' && info.companyId) {
    // Members subcollection doesn't include bio/avatarUrl. Lazily enrich with a small parallel fetch,
    // tolerating failures.
    await Promise.all(members.map(async (m) => {
      try {
        const p = await getUserProfile(m.uid);
        if (p) {
          m.bio = p.bio || m.bio || '';
          m.avatarUrl = p.avatarUrl || m.avatarUrl || null;
          m.role = p.role || m.role || null;
        }
      } catch (e) { /* best-effort */ }
    }));
  }

  $('grid').innerHTML = members.map(memberCardHtml).join('');
}

main();
