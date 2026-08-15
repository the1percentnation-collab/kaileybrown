// Profile page — edit own profile (no ?uid) OR view any member by uid.

import { db, firebaseReady, auth, functions } from './firebase.js';
import { onAuthReady, signOut } from './auth.js';
import { renderTopbar, renderTopbarEarly } from './topbar.js';
import { getRoleInfo } from './roles.js';
import { getUserProfile, updateOwnProfile, uploadAvatar, avatarHtml, escapeHtml } from './community.js';
import {
  collection, getDocs, query, where, getCountFromServer
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const $ = (id) => document.getElementById(id);
const TOTAL_MODULES = 7;

// ─── Edit mode ────────────────────────────────────────────────────────────
function val(s) { return s == null ? '' : escapeHtml(String(s)); }

function renderEdit(me) {
  const panel = $('panel');
  const completion = profileCompletion(me);
  panel.innerHTML = `
    <div class="profile-shell">
      <aside class="profile-side">
        <div class="profile-avatar-wrap">
          <div id="avatar-preview" class="profile-avatar-img">${avatarHtml(me, 140)}</div>
          <label class="profile-avatar-edit" title="Change avatar">
            <span>✎</span>
            <input id="avatar-file" type="file" accept="image/*" hidden>
          </label>
        </div>
        <div class="profile-side-name">${val(me.displayName || me.email || 'Member')}</div>
        ${me.profession ? `<div class="profile-side-role">${val(me.profession)}${me.company ? ` · ${val(me.company)}` : ''}</div>` : ''}
        <div id="avatar-status" class="profile-avatar-status"></div>

        <div class="profile-completion">
          <div class="profile-completion-head">
            <span>Profile completeness</span>
            <span class="profile-completion-pct">${completion}%</span>
          </div>
          <div class="profile-completion-bar"><div class="profile-completion-fill" style="width:${completion}%"></div></div>
          <p class="profile-completion-hint">A complete profile helps members connect with you and powers smarter community matching.</p>
        </div>
      </aside>

      <main class="profile-main">
        <header class="profile-header">
          <div>
            <div class="profile-eyebrow">Member Profile</div>
            <h1 class="profile-title">Your <span>Profile</span></h1>
            <p class="profile-sub">Update how you show up across the Academy and Community.</p>
          </div>
          <div class="profile-header-actions">
            <button class="btn btn-primary" id="save-btn">Save changes</button>
            <div id="save-status" class="profile-save-status"></div>
          </div>
        </header>

        <section class="profile-card">
          <div class="profile-card-head">
            <h2>Basics</h2>
            <p>Public — shown on your profile and in the community.</p>
          </div>
          <div class="profile-grid">
            <div class="profile-field">
              <label for="field-name">Display name</label>
              <input id="field-name" class="profile-input" type="text" value="${val(me.displayName)}" placeholder="Jane Doe">
            </div>
            <div class="profile-field">
              <label for="field-pronouns">Pronouns <span class="profile-opt">(optional)</span></label>
              <input id="field-pronouns" class="profile-input" type="text" value="${val(me.pronouns)}" placeholder="he/him, she/her, they/them">
            </div>
            <div class="profile-field profile-field-full">
              <label for="field-bio">Bio</label>
              <textarea id="field-bio" class="profile-input profile-textarea" rows="4" placeholder="Tell the community a bit about yourself — your journey, what drives you, what you're working on…">${val(me.bio)}</textarea>
            </div>
          </div>
        </section>

        <section class="profile-card">
          <div class="profile-card-head">
            <h2>Professional</h2>
            <p>Helps members find peers in similar roles and industries.</p>
          </div>
          <div class="profile-grid">
            <div class="profile-field">
              <label for="field-profession">Profession / Title</label>
              <input id="field-profession" class="profile-input" type="text" value="${val(me.profession)}" placeholder="Founder · CEO · Director of Strategy">
            </div>
            <div class="profile-field">
              <label for="field-company">Company / Organization</label>
              <input id="field-company" class="profile-input" type="text" value="${val(me.company)}" placeholder="Acme Inc.">
            </div>
            <div class="profile-field">
              <label for="field-industry">Industry</label>
              <input id="field-industry" class="profile-input" type="text" value="${val(me.industry)}" placeholder="Coaching · Tech · Healthcare · Finance…" list="industry-options">
              <datalist id="industry-options">
                <option value="Coaching & Personal Development"></option>
                <option value="Technology"></option>
                <option value="Finance"></option>
                <option value="Healthcare"></option>
                <option value="Education"></option>
                <option value="Real Estate"></option>
                <option value="Marketing & Media"></option>
                <option value="Consulting"></option>
                <option value="Entrepreneurship"></option>
                <option value="Nonprofit"></option>
                <option value="Government / Public Service"></option>
                <option value="Other"></option>
              </datalist>
            </div>
            <div class="profile-field">
              <label for="field-location">Location</label>
              <input id="field-location" class="profile-input" type="text" value="${val(me.location)}" placeholder="City, Country">
            </div>
          </div>
        </section>

        <section class="profile-card">
          <div class="profile-card-head">
            <h2>Community goals</h2>
            <p>What do you want to get from being here? Used to match you with people and content.</p>
          </div>
          <div class="profile-grid">
            <div class="profile-field profile-field-full">
              <textarea id="field-goals" class="profile-input profile-textarea" rows="3" placeholder="e.g. Build a clearer sense of purpose, connect with values-driven leaders, launch my next chapter…">${val(me.communityGoals)}</textarea>
            </div>
          </div>
        </section>

        <section class="profile-card">
          <div class="profile-card-head">
            <h2>Links</h2>
            <p>Optional. LinkedIn helps members verify and connect; website is shown publicly.</p>
          </div>
          <div class="profile-grid">
            <div class="profile-field">
              <label for="field-linkedin">LinkedIn URL</label>
              <input id="field-linkedin" class="profile-input" type="url" value="${val(me.linkedinUrl)}" placeholder="https://linkedin.com/in/yourname">
            </div>
            <div class="profile-field">
              <label for="field-website">Personal / company website</label>
              <input id="field-website" class="profile-input" type="url" value="${val(me.website)}" placeholder="https://yoursite.com">
            </div>
          </div>
        </section>

        <section class="profile-card">
          <div class="profile-card-head">
            <h2>Private contact <span class="profile-lock">🔒</span></h2>
            <p>Only visible to you and Academy admins. Never shown publicly.</p>
          </div>
          <div class="profile-grid">
            <div class="profile-field">
              <label for="field-email">Email</label>
              <input id="field-email" class="profile-input" type="email" value="${val(me.email)}" disabled>
            </div>
            <div class="profile-field">
              <label for="field-phone">Phone <span class="profile-opt">(optional)</span></label>
              <input id="field-phone" class="profile-input" type="tel" value="${val(me.phone)}" placeholder="+1 555 123 4567">
            </div>
          </div>
        </section>

        <section class="profile-section" id="privacy-section">
          <div class="profile-section-head">
            <h3>Privacy &amp; your data</h3>
            <p>Download a copy of your personal data, or permanently delete your account. See our <a href="/privacy.html">Privacy Policy</a>.</p>
          </div>
          <div class="profile-privacy-actions" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
            <button class="btn btn-ghost" id="data-export-btn" type="button">Download my data</button>
            <button class="btn btn-ghost" id="account-delete-btn" type="button"
              style="color:var(--red,#E60306);border-color:var(--red,#E60306);">Delete my account</button>
            <div id="privacy-status" class="profile-save-status"></div>
          </div>
        </section>

        <div class="profile-footer-actions">
          <button class="btn btn-primary btn-lg" id="save-btn-2">Save changes</button>
          <div id="save-status-2" class="profile-save-status"></div>
        </div>
      </main>
    </div>
  `;

  $('avatar-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('avatar-status').textContent = 'Uploading…';
    try {
      const url = await uploadAvatar(f);
      me.avatarUrl = url;
      $('avatar-preview').innerHTML = avatarHtml(me, 140);
      await updateOwnProfile({ avatarUrl: url });
      $('avatar-status').textContent = 'Saved ✓';
      setTimeout(() => { $('avatar-status').textContent = ''; }, 2000);
    } catch (err) {
      $('avatar-status').textContent = 'Upload failed: ' + (err.message || err);
    }
  });

  async function doSave(statusId) {
    const status = $(statusId);
    const payload = {
      displayName:    $('field-name').value,
      pronouns:       $('field-pronouns').value,
      bio:            $('field-bio').value,
      profession:     $('field-profession').value,
      company:        $('field-company').value,
      industry:       $('field-industry').value,
      location:       $('field-location').value,
      communityGoals: $('field-goals').value,
      linkedinUrl:    $('field-linkedin').value,
      website:        $('field-website').value,
      phone:          $('field-phone').value,
    };
    status.textContent = 'Saving…';
    try {
      await updateOwnProfile(payload);
      Object.entries(payload).forEach(([k, v]) => { me[k] = (v || '').trim(); });
      status.textContent = '✓ Saved';
      // Refresh completion bar
      const c = profileCompletion(me);
      const bar = document.querySelector('.profile-completion-fill');
      const pct = document.querySelector('.profile-completion-pct');
      if (bar) bar.style.width = c + '%';
      if (pct) pct.textContent = c + '%';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (err) {
      status.textContent = 'Error: ' + (err.message || err);
    }
  }
  $('save-btn').addEventListener('click', () => doSave('save-status'));
  $('save-btn-2').addEventListener('click', () => doSave('save-status-2'));

  // ── Privacy: self-service data export + account deletion ──────────────────
  const exportBtn = $('data-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const status = $('privacy-status');
    exportBtn.disabled = true;
    status.textContent = 'Preparing your data…';
    try {
      const call = httpsCallable(functions, 'requestDataExport');
      const res = await call({});
      const blob = new Blob([JSON.stringify(res.data && res.data.data ? res.data.data : res.data, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'my-data-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      status.textContent = '✓ Download started';
      setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (err) {
      status.textContent = 'Export failed: ' + (err.message || err);
    } finally {
      exportBtn.disabled = false;
    }
  });

  const deleteBtn = $('account-delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    const status = $('privacy-status');
    const typed = window.prompt(
      'This will PERMANENTLY delete your account and all your data. This cannot be undone.\n\nType DELETE to confirm.');
    if ((typed || '').trim().toUpperCase() !== 'DELETE') {
      status.textContent = 'Deletion cancelled.';
      setTimeout(() => { status.textContent = ''; }, 3000);
      return;
    }
    deleteBtn.disabled = true;
    status.textContent = 'Deleting your account…';
    try {
      const call = httpsCallable(functions, 'deleteMyAccount');
      await call({});
      // The Auth user is now gone; sign out locally and send them home.
      try { await signOut(); } catch (e) {}
      window.alert('Your account and data have been deleted.');
      location.replace('/index.html');
    } catch (err) {
      status.textContent = 'Deletion failed: ' + (err.message || err);
      deleteBtn.disabled = false;
    }
  });
}

function profileCompletion(me) {
  const fields = ['displayName','bio','profession','company','industry','location','communityGoals','linkedinUrl','website','avatarUrl'];
  const filled = fields.filter((f) => me && me[f] && String(me[f]).trim().length > 0).length;
  return Math.round((filled / fields.length) * 100);
}

// ─── View mode ────────────────────────────────────────────────────────────
async function renderView(profile, viewer) {
  const panel = $('panel');
  if (!profile) {
    panel.innerHTML = `<div class="card"><div class="auth-error">Profile not found or not accessible.</div></div>`;
    return;
  }
  const role = profile.role || 'user';
  const roleBadge = role === 'owner'
    ? `<span class="c-role-badge c-role-owner">Owner</span>`
    : role === 'admin' ? `<span class="c-role-badge c-role-admin">Admin</span>` : '';

  // Try to compute progress + post/comment counts (best-effort).
  let completedCount = 0;
  let postsCount = null;
  let commentsCount = null;
  try {
    // Progress reads are private (rules). We can only read progress for self or owner.
    // Skip unless viewer is self or owner. For company admins we show 0 or 'private'.
    if (viewer && (viewer.uid === profile.uid || viewer.role === 'owner')) {
      const snap = await getDocs(collection(db, 'users', profile.uid, 'progress'));
      snap.forEach((d) => { if (d.data().completed) completedCount++; });
    }
  } catch (e) {}
  try {
    const c = await getCountFromServer(query(collection(db, 'posts'), where('authorUid', '==', profile.uid)));
    postsCount = c.data().count;
  } catch (e) { /* count queries may not be allowed — fine */ }

  const pct = Math.min(100, Math.round((completedCount / TOTAL_MODULES) * 100));
  const linkRow = (label, val, href) => val ? `
    <div class="profile-view-link"><span class="profile-view-link-label">${label}</span>
      ${href ? `<a class="profile-view-link-val" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(val)}</a>` : `<span class="profile-view-link-val">${escapeHtml(val)}</span>`}
    </div>` : '';
  const roleLine = [profile.profession, profile.company].filter(Boolean).map(escapeHtml).join(' · ');
  panel.innerHTML = `
    <div class="profile-shell">
      <aside class="profile-side">
        <div class="profile-avatar-wrap">${avatarHtml(profile, 140)}</div>
        <div class="profile-side-name">${escapeHtml(profile.displayName || profile.email || 'Member')} ${roleBadge}</div>
        ${roleLine ? `<div class="profile-side-role">${roleLine}</div>` : ''}
        ${profile.location ? `<div class="profile-side-meta">📍 ${escapeHtml(profile.location)}</div>` : ''}
        ${profile.pronouns ? `<div class="profile-side-meta">${escapeHtml(profile.pronouns)}</div>` : ''}
      </aside>

      <main class="profile-main">
        ${profile.bio ? `<section class="profile-card"><div class="profile-card-head"><h2>About</h2></div><p class="profile-view-bio">${escapeHtml(profile.bio)}</p></section>` : ''}

        ${(profile.industry || profile.communityGoals) ? `
          <section class="profile-card">
            <div class="profile-card-head"><h2>In the community</h2></div>
            ${profile.industry ? `<div class="profile-view-link"><span class="profile-view-link-label">Industry</span><span class="profile-view-link-val">${escapeHtml(profile.industry)}</span></div>` : ''}
            ${profile.communityGoals ? `<div class="profile-view-link"><span class="profile-view-link-label">Goals</span><span class="profile-view-link-val">${escapeHtml(profile.communityGoals)}</span></div>` : ''}
          </section>` : ''}

        ${(profile.linkedinUrl || profile.website) ? `
          <section class="profile-card">
            <div class="profile-card-head"><h2>Links</h2></div>
            ${linkRow('LinkedIn', profile.linkedinUrl, profile.linkedinUrl)}
            ${linkRow('Website', profile.website, profile.website)}
          </section>` : ''}

        <section class="profile-card">
          <div class="profile-card-head"><h2>Activity</h2></div>
          <div class="profile-view-stats">
            ${viewer && (viewer.uid === profile.uid || viewer.role === 'owner') ? `
              <div class="profile-view-stat">
                <div class="profile-view-stat-label">Modules</div>
                <div class="profile-view-stat-value">${completedCount}/${TOTAL_MODULES}</div>
                <div class="c-progress-bar" style="margin-top:8px;"><div class="c-progress-fill" style="width:${pct}%"></div></div>
              </div>` : ''}
            ${postsCount != null ? `
              <div class="profile-view-stat">
                <div class="profile-view-stat-label">Community posts</div>
                <div class="profile-view-stat-value">${postsCount}</div>
              </div>` : ''}
          </div>
        </section>
      </main>
    </div>
  `;
}

async function main() {
  if (!firebaseReady) {
    $('panel').innerHTML = `<div class="card"><div class="auth-error">Firebase is unavailable.</div></div>`;
    return;
  }
  const u = await onAuthReady();
  if (!u) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    return;
  }
  // Header first — it carries the Admin/Owner menu and must survive a slow or
  // failed load below.
  renderTopbarEarly({ user: u, currentPage: 'profile' });

  const info = await getRoleInfo();
  const myProfile = (await getUserProfile(u.uid)) || {};
  const me = {
    uid: u.uid,
    email: u.email,
    displayName: myProfile.displayName || u.displayName || u.email,
    avatarUrl: myProfile.avatarUrl || null,
    bio: myProfile.bio || '',
    profession: myProfile.profession || '',
    company: myProfile.company || '',
    industry: myProfile.industry || '',
    location: myProfile.location || '',
    linkedinUrl: myProfile.linkedinUrl || '',
    website: myProfile.website || '',
    phone: myProfile.phone || '',
    communityGoals: myProfile.communityGoals || '',
    pronouns: myProfile.pronouns || '',
    role: info.role
  };
  renderTopbar({ user: me, profile: me, role: info.role, currentPage: 'profile' });

  const urlUid = new URLSearchParams(location.search).get('uid');
  if (!urlUid || urlUid === u.uid) {
    renderEdit(me);
  } else {
    // Read-only view of another user. Firestore rules allow self + owner + company admin
    // of target's company. Regular company users cannot read peer user docs directly, so
    // fall back to the companies/{cid}/members/{uid} digest for non-privileged viewers.
    let profile = null;
    try {
      profile = await getUserProfile(urlUid);
    } catch (e) { /* ignore */ }
    if (!profile && info.companyId) {
      // Try members digest.
      try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
        const m = await getDoc(doc(db, 'companies', info.companyId, 'members', urlUid));
        if (m.exists()) profile = { uid: urlUid, ...m.data() };
      } catch (e) {}
    }
    if (!profile) profile = { uid: urlUid, displayName: 'Member' };
    profile.uid = urlUid;
    await renderView(profile, me);
  }
}

main();
