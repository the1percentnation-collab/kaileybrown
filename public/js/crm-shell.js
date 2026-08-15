// GoHighLevel-style CRM app shell — a left sidebar + main column with an
// appbar. Every CRM subpage calls renderCrmShell() to get consistent chrome
// and then fills the returned #crm-content element. Keeps the brand red/ink
// brand and reuses renderTopbar for the user-chip (avatar/search/bell/signout).
//
//   import { renderCrmShell } from './crm-shell.js';
//   const content = renderCrmShell({ active: 'opportunities', title: 'Opportunities', user, role });
//   content.innerHTML = '…';
//
// Responsive: full sidebar on desktop, off-canvas drawer under 900px toggled
// by the appbar hamburger.

import { renderTopbar } from './topbar.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Live (built) destinations + "soon" placeholders for later phases so the
// full GHL nav is visible from day one without dead links.
const NAV = [
  { key: 'dashboard',     href: '/crm-dashboard.html', label: 'Dashboard',     icon: '◧' },
  { key: 'contacts',      href: '/crm.html',           label: 'Contacts',      icon: '☷' },
  { key: 'opportunities', href: '/opportunities.html', label: 'Opportunities', icon: '◆' },
  { key: 'tasks',         href: '/tasks.html',         label: 'Tasks',         icon: '✓' },
  { key: 'conversations', href: '/conversations.html', label: 'Conversations', icon: '✉' },
  { key: 'calendar',      href: '/calendar.html',      label: 'Calendar',      icon: '◷' },
  { key: 'campaigns',     href: '/campaigns.html',     label: 'Campaigns',     icon: '❏' },
  { key: 'settings',      href: '/crm-settings.html',  label: 'Settings',      icon: '⚙' }
];

function navItemHtml(item, active) {
  const isActive = item.key === active;
  if (item.soon) {
    return `<span class="crm-nav-item crm-nav-soon" title="Coming soon">
      <span class="crm-nav-icon">${item.icon}</span>
      <span class="crm-nav-label">${esc(item.label)}</span>
      <span class="crm-nav-soon-tag">soon</span>
    </span>`;
  }
  return `<a class="crm-nav-item ${isActive ? 'active' : ''}" href="${esc(item.href)}">
    <span class="crm-nav-icon">${item.icon}</span>
    <span class="crm-nav-label">${esc(item.label)}</span>
  </a>`;
}

/**
 * Render the shell into #crm-root and return the #crm-content element.
 * @returns {HTMLElement|null} the content container to fill.
 */
export function renderCrmShell({ active = 'contacts', title = 'CRM', user = null, role = null } = {}) {
  const root = document.getElementById('crm-root');
  if (!root) return null;

  root.innerHTML = `
    <div class="crm-app">
      <div class="crm-drawer-scrim" id="crm-drawer-scrim" hidden></div>
      <aside class="crm-sidebar" id="crm-sidebar">
        <a class="crm-sidebar-brand" href="/dashboard.html" aria-label="Kailey Brown Academy">
          <img src="/assets/academy-logo.png" alt="" class="crm-sidebar-logo">
          <span class="crm-sidebar-brandtext">CRM</span>
        </a>
        <nav class="crm-nav">
          ${NAV.map((i) => navItemHtml(i, active)).join('')}
        </nav>
        <div class="crm-sidebar-foot">
          <a class="crm-nav-item crm-nav-muted" href="https://kaileybrown.com">
            <span class="crm-nav-icon">←</span><span class="crm-nav-label">Main Site</span>
          </a>
        </div>
      </aside>
      <div class="crm-main">
        <header class="crm-appbar">
          <button class="crm-hamburger" id="crm-hamburger" aria-label="Menu">☰</button>
          <h1 class="crm-appbar-title">${esc(title)}</h1>
          <div class="crm-appbar-spacer"></div>
          <div class="user-chip" id="user-chip"></div>
        </header>
        <div class="crm-content" id="crm-content"></div>
      </div>
    </div>
  `;

  // User chip (avatar / search / bell / signout). Suppress the regular nav
  // chips — navigation lives in the sidebar — but keep admin/owner quick buttons.
  if (user) {
    renderTopbar({ user, role, mountId: 'user-chip', links: [] });
  }

  // Mobile drawer toggle.
  const sidebar = document.getElementById('crm-sidebar');
  const scrim = document.getElementById('crm-drawer-scrim');
  const ham = document.getElementById('crm-hamburger');
  const open = () => { sidebar.classList.add('open'); scrim.hidden = false; };
  const close = () => { sidebar.classList.remove('open'); scrim.hidden = true; };
  if (ham) ham.addEventListener('click', () => {
    sidebar.classList.contains('open') ? close() : open();
  });
  if (scrim) scrim.addEventListener('click', close);

  return document.getElementById('crm-content');
}
