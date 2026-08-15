// Shared topbar renderer (Phase 3 follow-up).
//
// Replaces the per-page renderChip() boilerplate with one call site:
//
//   import { renderTopbar, defaultTopbarLinks } from './topbar.js';
//
//   renderTopbar({
//     user: u,
//     profile,                       // { displayName, avatarUrl } | null
//     role: info.role,               // 'owner' | 'admin' | 'user' | null
//     currentPage: 'crm',            // omit the page's own self-link
//   });
//
// Pages that want a non-default link set pass `links: [...]` (each entry
// is `{ href, label }`). A `withBell: false` flag disables the bell on
// pages where notifications would be noise (e.g. resource pages on
// public sub-domains).
//
// The bell + unread popover live entirely inside this module so every
// page benefits from the inbox without each one re-implementing the
// listener. Cost per page: one bounded onSnapshot (limit 20) on the
// caller's notifications subcollection.

import { auth, db, functions, firebaseReady } from './firebase.js';
import { signOut } from './auth.js';
import { cachedRoleInfo } from './roles.js';
import {
  collection, doc, query, where, orderBy, limit, onSnapshot, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

// ────────────────────────────────────────────────────────────────
// Default link set
// ────────────────────────────────────────────────────────────────

const ALL_LINKS = [
  { key: 'dashboard',  href: '/dashboard.html', label: 'Dashboard' },
  { key: 'community',  href: '/community.html', label: 'Community' },
  { key: 'members',    href: '/members.html',   label: 'Members' },
  { key: 'profile',    href: '/profile.html',   label: 'Profile' },
  { key: 'crm',        href: '/crm.html',       label: 'CRM',       requires: 'admin' },
  { key: 'campaigns',  href: '/campaigns.html', label: 'Campaigns', requires: 'admin' },
  { key: 'admin',      href: '/admin.html',     label: 'Admin',     requires: 'admin' },
  { key: 'owner',      href: '/owner.html',     label: 'Owner',     requires: 'owner' }
];

function roleAllows(roleRequired, role) {
  if (!roleRequired) return true;
  if (roleRequired === 'admin') return role === 'admin' || role === 'owner';
  if (roleRequired === 'owner') return role === 'owner';
  return true;
}

// Privileged destinations consolidated into a single dropdown so the topbar
// stays uncluttered — one button instead of five separate red chips.
const ADMIN_BUTTONS = [
  { key: 'crm', href: '/crm.html', label: 'CRM', requires: 'admin' },
  { key: 'courses-admin', href: '/manage-courses.html', label: 'Manage Courses', requires: 'admin' },
  { key: 'products-admin', href: '/manage-products.html', label: 'Products', requires: 'admin' },
  { key: 'affiliates-admin', href: '/manage-affiliates.html', label: 'Affiliates', requires: 'admin' },
  { key: 'admin', href: '/admin.html', label: 'Admin', requires: 'admin' },
  { key: 'owner', href: '/owner.html', label: 'Owner', requires: 'owner' }
];

/**
 * Returns the role-aware default link set with the active page filtered out.
 * `currentPage` is one of the keys in ALL_LINKS (e.g. 'community', 'crm').
 */
export function defaultTopbarLinks({ role = null, currentPage = null } = {}) {
  return ALL_LINKS
    .filter((l) => roleAllows(l.requires, role))
    .filter((l) => l.key !== currentPage)
    .map(({ href, label }) => ({ href, label }));
}

/** Privileged buttons (Admin/Owner) the current role may see, minus the active page. */
function adminButtons({ role = null, currentPage = null } = {}) {
  return ADMIN_BUTTONS
    .filter((b) => roleAllows(b.requires, role))
    .filter((b) => b.key !== currentPage);
}

// ────────────────────────────────────────────────────────────────
// Avatar (kept inline so topbar.js doesn't import community.js — that
// module pulls firebase-storage and avatar uploads, which not every
// page should pay for at load time).
// ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  return (parts.slice(0, 2).map((p) => p[0] || '').join('').toUpperCase()) || '?';
}

function avatarHtml(profile, size = 28) {
  const name = (profile && (profile.displayName || profile.authorName)) || '';
  const src = profile && (profile.avatarUrl || profile.authorAvatar);
  const s = `width:${size}px; height:${size}px; font-size:${Math.round(size * 0.38)}px;`;
  if (src) return `<div class="c-avatar" style="${s}"><img src="${src}" alt="" loading="lazy"></div>`;
  return `<div class="c-avatar c-avatar-initials" style="${s}">${initials(name)}</div>`;
}

function fmtRelative(ts) {
  if (!ts) return 'just now';
  const ms = ts.toMillis ? ts.toMillis() : (ts instanceof Date ? ts.getTime() : Number(ts));
  if (!ms) return 'just now';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  try { return new Date(ms).toLocaleDateString(); } catch (e) { return `${d}d ago`; }
}

// ────────────────────────────────────────────────────────────────
// Bell — unread notifications listener + popover
// ────────────────────────────────────────────────────────────────

const bellState = {
  unsub: null,
  unread: [],
  showing: false,
  mountId: null,
  outsideClickBound: false
};

function notifIcon(type) {
  if (type === 'like') return '❤️';
  if (type === 'comment') return '💬';
  if (type === 'mention') return '@';
  if (type === 'channel_request') return '🔑';
  if (type === 'channel_access_granted') return '🔓';
  if (type === 'channel_access_denied') return '🔒';
  return '🔔';
}

function channelLabel(n) {
  return escapeHtml(n.channelName || n.category || 'a channel');
}

function notifLine(n) {
  const who = escapeHtml(n.fromName || 'Someone');
  if (n.type === 'like') return `${who} liked your post`;
  if (n.type === 'comment') return `${who} commented on your post`;
  if (n.type === 'mention') return `${who} mentioned you`;
  if (n.type === 'channel_request') return `${who} requested access to ${channelLabel(n)}`;
  if (n.type === 'channel_access_granted') return `You now have access to ${channelLabel(n)}`;
  if (n.type === 'channel_access_denied') return `Your request for ${channelLabel(n)} wasn't approved`;
  return `${who} did something`;
}

/** Channel-access notifications carry no postId — link to the channel itself. */
function isChannelNotif(n) {
  return !!n && typeof n.type === 'string' && n.type.startsWith('channel_');
}

function notifHref(n) {
  if (isChannelNotif(n) && n.category) {
    return `/community.html?channel=${encodeURIComponent(n.category)}`;
  }
  if (!n || !n.postId) return '/community.html';
  const channel = n.category || 'general';
  return `/community.html?channel=${encodeURIComponent(channel)}#post-${encodeURIComponent(n.postId)}`;
}

function getBadgeEl() {
  const root = bellState.mountId ? document.getElementById(bellState.mountId) : null;
  return root ? root.querySelector('#bell-badge') : null;
}

function getPopoverEl() {
  const root = bellState.mountId ? document.getElementById(bellState.mountId) : null;
  return root ? root.querySelector('#notif-popover') : null;
}

function renderBellBadge() {
  const badge = getBadgeEl();
  if (!badge) return;
  const count = bellState.unread.length;
  if (count <= 0) {
    badge.hidden = true;
    badge.textContent = '0';
    return;
  }
  badge.hidden = false;
  badge.textContent = count >= 20 ? '20+' : String(count);
}

function renderNotifPopover() {
  const pop = getPopoverEl();
  if (!pop) return;
  const rows = bellState.unread;
  const headerHtml = `
    <div class="c-notif-head">
      <span class="c-notif-title">Notifications</span>
      <button class="c-notif-mark-all" id="notif-mark-all" ${rows.length ? '' : 'disabled'}>Mark all read</button>
    </div>
  `;
  const bodyHtml = rows.length ? rows.map((n) => {
    // Access requests are actionable from the bell so staff can approve from a
    // phone without opening the community page. The buttons sit inside the <a>,
    // so their handlers must stopPropagation or the row navigates away.
    // When the channel asks applicants questions, DON'T offer a one-tap Approve
    // here — the answers don't fit in a notification row, and approving an
    // application you haven't read defeats the point of collecting one. Those
    // link through to the channel's review panel instead.
    const isRequest = n.type === 'channel_request' && n.category && n.fromUid;
    const hasAnswers = isRequest && Number(n.answerCount || 0) > 0;
    const actions = !isRequest ? '' : hasAnswers
      ? `<div class="c-notif-actions">
           <span class="c-notif-review">Open the channel to read their answers →</span>
         </div>`
      : `<div class="c-notif-actions">
           <button class="c-notif-approve" data-approve="${escapeHtml(n.category)}" data-uid="${escapeHtml(n.fromUid)}" data-notif-id="${escapeHtml(n.id)}">Approve</button>
           <button class="c-notif-deny" data-deny="${escapeHtml(n.category)}" data-uid="${escapeHtml(n.fromUid)}" data-notif-id="${escapeHtml(n.id)}">Deny</button>
         </div>`;
    return `
    <a class="c-notif-row unread" data-notif="${escapeHtml(n.id)}" href="${escapeHtml(notifHref(n))}">
      <span class="c-notif-icon">${notifIcon(n.type)}</span>
      ${avatarHtml({ avatarUrl: n.fromAvatar, displayName: n.fromName }, 28)}
      <div class="c-notif-body">
        <div class="c-notif-line">${notifLine(n)}</div>
        ${n.preview ? `<div class="c-notif-preview">${escapeHtml(n.preview)}</div>` : ''}
        <div class="c-notif-time">${fmtRelative(n.createdAt)}</div>
        ${actions}
      </div>
    </a>`;
  }).join('') : `<div class="c-notif-empty">You're all caught up.</div>`;
  pop.innerHTML = headerHtml + `<div class="c-notif-list">${bodyHtml}</div>`;

  pop.querySelectorAll('.c-notif-row').forEach((a) => {
    a.addEventListener('click', async (e) => {
      const id = a.dataset.notif;
      // Mark read in the background; let the navigation proceed.
      try { await markNotifReadById(id); } catch (er) {}
      bellState.showing = false;
      pop.hidden = true;
      // The default <a href> navigates to /community.html?channel=…#post-…
      // which community-page.js handles via its hashchange + initial-hash code.
    });
  });

  pop.querySelectorAll('[data-approve], [data-deny]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      // Keep the row from navigating and the popover from closing.
      e.preventDefault();
      e.stopPropagation();
      const approve = btn.hasAttribute('data-approve');
      const channelKey = btn.getAttribute(approve ? 'data-approve' : 'data-deny');
      const uid = btn.dataset.uid;
      const row = btn.closest('.c-notif-body');
      btn.disabled = true;
      try {
        const call = httpsCallable(functions, 'decideChannelAccess');
        await call({ channelKey, uid, approve });
        if (row) {
          row.querySelector('.c-notif-actions').outerHTML =
            `<div class="c-notif-decided">${approve ? 'Approved ✓' : 'Denied'}</div>`;
        }
        try { await markNotifReadById(btn.dataset.notifId); } catch (er) {}
      } catch (err) {
        btn.disabled = false;
        if (row) {
          const holder = row.querySelector('.c-notif-actions');
          if (holder) holder.insertAdjacentHTML('beforeend',
            `<span class="c-notif-err">${escapeHtml(err.message || 'Failed')}</span>`);
        }
      }
    });
  });

  const markAll = pop.querySelector('#notif-mark-all');
  if (markAll) markAll.addEventListener('click', async () => {
    const ids = bellState.unread.map((n) => n.id);
    await Promise.all(ids.map((id) => markNotifReadById(id).catch(() => {})));
  });
}

async function markNotifReadById(notifId) {
  const user = auth && auth.currentUser;
  if (!user || !notifId || !firebaseReady) return;
  try {
    await updateDoc(doc(db, 'users', user.uid, 'notifications', notifId), { read: true });
  } catch (e) {
    console.warn('[topbar] markNotifRead failed', e);
  }
}

function bindBellHandlers() {
  const root = document.getElementById(bellState.mountId);
  if (!root) return;
  const btn = root.querySelector('#btn-bell');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = getPopoverEl();
      if (!pop) return;
      bellState.showing = !bellState.showing;
      if (bellState.showing) {
        renderNotifPopover();
        pop.hidden = false;
      } else {
        pop.hidden = true;
      }
    });
  }
  if (!bellState.outsideClickBound) {
    bellState.outsideClickBound = true;
    document.addEventListener('click', (e) => {
      if (!bellState.showing) return;
      const pop = getPopoverEl();
      const rootNow = document.getElementById(bellState.mountId);
      if (!pop || !rootNow) return;
      const bellBtn = rootNow.querySelector('#btn-bell');
      if (pop.contains(e.target) || (bellBtn && bellBtn.contains(e.target))) return;
      bellState.showing = false;
      pop.hidden = true;
    });
  }
}

function startBellListener(uid) {
  if (bellState.unsub) { try { bellState.unsub(); } catch (e) {} bellState.unsub = null; }
  if (!firebaseReady || !uid) return;
  const q = query(
    collection(db, 'users', uid, 'notifications'),
    where('read', '==', false),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  bellState.unsub = onSnapshot(q, (snap) => {
    bellState.unread = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderBellBadge();
    if (bellState.showing) renderNotifPopover();
  }, (err) => {
    console.warn('[topbar] notifications listener error', err);
    bellState.unread = [];
    renderBellBadge();
  });
}

// ────────────────────────────────────────────────────────────────
// Search overlay — command-palette-style search across posts +
// people. Triggered by the topbar 🔍 button or Cmd/Ctrl-K. Calls
// the searchPosts and searchMembers callables in parallel.
// ────────────────────────────────────────────────────────────────

const searchState = {
  open: false,
  overlay: null,
  debounce: null,
  lastQuery: '',
  keyboundGlobal: false
};

function notifHrefForSearchPost(p) {
  if (!p || !p.id) return '/community.html';
  const ch = p.category || 'general';
  return `/community.html?channel=${encodeURIComponent(ch)}#post-${encodeURIComponent(p.id)}`;
}

function relativeTimeShort(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function openSearchOverlay() {
  if (searchState.open) return;
  if (!firebaseReady || !functions) return;

  const overlay = document.createElement('div');
  overlay.className = 'c-search-overlay';
  overlay.id = 'c-search-overlay';
  overlay.innerHTML = `
    <div class="c-search-card" role="dialog" aria-label="Search">
      <div class="c-search-input-row">
        <span class="c-search-icon-lg">🔍</span>
        <input id="c-search-input" class="c-search-input" type="text"
               placeholder="Search posts and people…" autocomplete="off"
               spellcheck="false">
        <span class="c-search-kbd">esc</span>
      </div>
      <div class="c-search-results" id="c-search-results">
        <div class="c-search-hint">Type at least 2 characters to search.</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  searchState.overlay = overlay;
  searchState.open = true;

  const input = document.getElementById('c-search-input');
  setTimeout(() => input && input.focus(), 0);

  const close = () => {
    if (searchState.debounce) { clearTimeout(searchState.debounce); searchState.debounce = null; }
    if (searchState.overlay) searchState.overlay.remove();
    searchState.overlay = null;
    searchState.open = false;
    searchState.lastQuery = '';
  };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escClose);
    }
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (searchState.debounce) clearTimeout(searchState.debounce);
    if (!q || q.length < 2) {
      renderSearchResults({ posts: [], people: [], hint: 'Type at least 2 characters to search.' });
      return;
    }
    renderSearchResults({ loading: true });
    searchState.debounce = setTimeout(() => runSearch(q), 220);
  });
}

async function runSearch(q) {
  if (q === searchState.lastQuery && searchState.lastQuery !== '') return;
  searchState.lastQuery = q;
  try {
    const [postsRes, peopleRes] = await Promise.all([
      httpsCallable(functions, 'searchPosts')({ query: q }).then((r) => r.data).catch(() => ({ results: [] })),
      httpsCallable(functions, 'searchMembers')({ query: q }).then((r) => r.data).catch(() => ({ results: [] }))
    ]);
    renderSearchResults({
      posts: (postsRes && postsRes.results) || [],
      people: (peopleRes && peopleRes.results) || []
    });
  } catch (err) {
    renderSearchResults({ posts: [], people: [], hint: 'Search failed. Try again.' });
  }
}

function renderSearchResults({ posts = [], people = [], loading = false, hint = null }) {
  const root = document.getElementById('c-search-results');
  if (!root) return;
  if (loading) {
    root.innerHTML = `<div class="c-search-hint">Searching…</div>`;
    return;
  }
  if (hint && !posts.length && !people.length) {
    root.innerHTML = `<div class="c-search-hint">${escapeHtml(hint)}</div>`;
    return;
  }
  if (!posts.length && !people.length) {
    root.innerHTML = `<div class="c-search-hint">No matches.</div>`;
    return;
  }

  const peopleHtml = people.length ? `
    <div class="c-search-section">
      <div class="c-search-section-title">People</div>
      ${people.slice(0, 5).map((p) => `
        <a class="c-search-row" href="/profile.html?uid=${encodeURIComponent(p.uid)}">
          ${avatarHtml({ avatarUrl: p.avatarUrl, displayName: p.displayName }, 28)}
          <div class="c-search-row-body">
            <div class="c-search-row-title">${escapeHtml(p.displayName || 'Unknown')}</div>
          </div>
          <span class="c-search-row-meta">profile</span>
        </a>
      `).join('')}
    </div>
  ` : '';

  const postsHtml = posts.length ? `
    <div class="c-search-section">
      <div class="c-search-section-title">Posts</div>
      ${posts.slice(0, 5).map((p) => `
        <a class="c-search-row" href="${escapeHtml(notifHrefForSearchPost(p))}">
          ${avatarHtml({ avatarUrl: p.authorAvatar, displayName: p.authorName }, 28)}
          <div class="c-search-row-body">
            <div class="c-search-row-title">${escapeHtml((p.text || '').slice(0, 80))}${(p.text || '').length > 80 ? '…' : ''}</div>
            <div class="c-search-row-sub">${escapeHtml(p.authorName || 'Unknown')} · #${escapeHtml(p.category || 'general')} · ${escapeHtml(relativeTimeShort(p.createdAt))}</div>
          </div>
          <span class="c-search-row-meta">${p.likeCount || 0} ❤</span>
        </a>
      `).join('')}
    </div>
  ` : '';

  root.innerHTML = peopleHtml + postsHtml;
}

// ────────────────────────────────────────────────────────────────
// renderTopbar — the public entry point
// ────────────────────────────────────────────────────────────────

/**
 * Paint the user-chip and (optionally) wire up the notification bell.
 * Idempotent — safe to call again on role / profile change.
 */
export function renderTopbar({
  user,
  profile = null,
  role = null,
  currentPage = null,
  links = null,
  mountId = 'user-chip',
  withBell = true,
  withSearch = true,
  withSignOut = true,
  signOutLabel = 'Sign out'
} = {}) {
  const chip = document.getElementById(mountId);
  if (!chip || !user) return;

  // Privileged destinations render as dedicated buttons, so drop them from the
  // regular chip list to avoid a duplicate when the default link set is in use.
  const adminButtonHrefs = ADMIN_BUTTONS.map((b) => b.href);
  const linkSet = (links || defaultTopbarLinks({ role, currentPage }))
    .filter((l) => !adminButtonHrefs.includes(l.href));
  const linksHtml = linkSet.map((l) =>
    `<a class="user-chip-link" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`
  ).join('');

  const adminBtns = adminButtons({ role, currentPage });
  const dropLabel = role === 'owner' ? 'Owner&nbsp;&#9660;' : 'Admin&nbsp;&#9660;';
  const adminHtml = adminBtns.length === 0 ? '' : `
    <div class="c-admin-dropdown" id="c-admin-dropdown">
      <button class="user-chip-admin c-admin-dropdown-toggle" id="c-admin-dropdown-btn" type="button">${dropLabel}</button>
    </div>
  `;

  const displayName = (profile && profile.displayName) || user.displayName || user.email || '';
  const avatarObj = {
    displayName,
    avatarUrl: (profile && profile.avatarUrl) || null
  };
  const avatarHtmlStr = `<a href="/profile.html" class="c-avatar-link" title="Your profile">${avatarHtml(avatarObj, 28)}</a>`;

  const bellHtml = withBell ? `
    <button class="c-bell" id="btn-bell" title="Notifications" aria-label="Notifications">
      <span class="c-bell-icon">🔔</span>
      <span class="c-bell-badge" id="bell-badge" hidden>0</span>
    </button>
    <div class="c-notif-popover" id="notif-popover" hidden></div>
  ` : '';

  const searchHtml = withSearch ? `
    <button class="c-search-btn" id="btn-search" title="Search" aria-label="Search">
      <span class="c-search-icon">🔍</span>
    </button>
  ` : '';

  const signOutHtml = withSignOut
    ? `<button class="btn btn-ghost" id="btn-signout">${escapeHtml(signOutLabel)}</button>`
    : '';

  chip.innerHTML = `
    ${adminHtml}
    ${linksHtml}
    ${searchHtml}
    ${bellHtml}
    ${avatarHtmlStr}
    <span class="user-chip-email">${escapeHtml(displayName)}</span>
    ${signOutHtml}
  `;

  // Admin dropdown — menu lives on <body> so it's never clipped by overflow.
  const ddBtn = chip.querySelector('#c-admin-dropdown-btn');
  if (ddBtn && adminBtns.length) {
    const MENU_ID = 'c-admin-dropdown-menu';

    const closeMenu = () => {
      const m = document.getElementById(MENU_ID);
      if (m) m.remove();
    };

    const openMenu = () => {
      const rect = ddBtn.getBoundingClientRect();
      const menu = document.createElement('div');
      menu.className = 'c-admin-dropdown-menu';
      menu.id = MENU_ID;
      menu.style.top = (rect.bottom + 6) + 'px';
      menu.style.right = (window.innerWidth - rect.right) + 'px';
      menu.innerHTML = adminBtns.map((b) =>
        `<a class="c-admin-dropdown-item" href="${escapeHtml(b.href)}">${escapeHtml(b.label)}</a>`
      ).join('');
      document.body.appendChild(menu);
      // Attach outside-click dismissal after this tick so the opening tap
      // doesn't immediately trigger it on mobile.
      setTimeout(() => {
        document.addEventListener('click', closeMenu, { once: true });
        document.addEventListener('touchend', closeMenu, { once: true, passive: true });
      }, 0);
    };

    ddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (document.getElementById(MENU_ID)) { closeMenu(); } else { openMenu(); }
    });
  }

  if (withSignOut) {
    const out = chip.querySelector('#btn-signout');
    if (out) out.addEventListener('click', async () => {
      try { await signOut(); } catch (e) {}
      location.replace('/login.html');
    });
  }

  if (withSearch) {
    const sb = chip.querySelector('#btn-search');
    if (sb) sb.addEventListener('click', openSearchOverlay);
    if (!searchState.keyboundGlobal) {
      searchState.keyboundGlobal = true;
      document.addEventListener('keydown', (e) => {
        // Cmd/Ctrl-K opens search from anywhere.
        const isMac = navigator.platform.toUpperCase().includes('MAC');
        const meta = isMac ? e.metaKey : e.ctrlKey;
        if (meta && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          openSearchOverlay();
        }
      });
    }
  }

  if (withBell) {
    bellState.mountId = mountId;
    bindBellHandlers();
    startBellListener(user.uid);
  }

  // On mobile the tabs row scrolls horizontally — bring the active tab into view.
  requestAnimationFrame(() => {
    const activeTab = document.querySelector('.academy-tab.active');
    if (activeTab) {
      try { activeTab.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {}
    }
  });
}

/**
 * First-paint topbar. Call this as soon as auth resolves, BEFORE any page data
 * loads — the topbar carries the Admin/Owner menu, which on most pages is the
 * only route into the consoles. Painting it last meant one slow or failed
 * Firestore read left the header empty and the admin area unreachable.
 *
 * Role comes from the synchronous localStorage cache, so a returning admin gets
 * the menu immediately. Pass `role: null` (the default for a first-ever load) and
 * the menu simply appears when the page's own `renderTopbar` call lands with the
 * authoritative role. Safe to call twice — `renderTopbar` is idempotent.
 */
export function renderTopbarEarly(opts = {}) {
  const cached = cachedRoleInfo();
  renderTopbar({ role: cached ? cached.role : null, ...opts });
}

/** Stop any active bell listener. Call from `beforeunload` or on signout. */
export function teardownTopbar() {
  if (bellState.unsub) { try { bellState.unsub(); } catch (e) {} }
  bellState.unsub = null;
  bellState.unread = [];
  bellState.showing = false;
}
