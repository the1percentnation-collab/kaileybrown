// Store — persists course progress + per-module notes.
// Public API (kept stable so app.js does not change):
//   store.load()                  → async; loads state (Firestore if authed, localStorage otherwise)
//   store.setCurrent(id)          → updates current module
//   store.markComplete(id)        → marks module complete
//   store.isComplete(id) -> bool
//   store.currentModule           → number
//   store.completed               → Set<number>
//   saveNote(key, value)
//   getNotes(key) -> string
//
// Behaviour:
//   - If Firebase is ready and a user is signed in, writes go to Firestore and mirror to
//     localStorage as an offline cache / instant-read fallback.
//   - If not signed in or Firebase init failed, falls back to localStorage only.
//   - On first login where the user's Firestore progress is empty, any existing
//     localStorage progress + notes are migrated up.

import { auth, db, firebaseReady } from './firebase.js';
import {
  doc, getDoc, setDoc, collection, getDocs, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const STATE_KEY = 'kb_course_state';
const NOTE_PREFIX = 'kb_note_';

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
function lsKeys() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); } catch (e) {}
  return out;
}

function loadLocalState() {
  try {
    const raw = lsGet(STATE_KEY);
    if (!raw) return { current: 0, completed: [] };
    const p = JSON.parse(raw);
    return { current: p.current || 0, completed: p.completed || [] };
  } catch (e) { return { current: 0, completed: [] }; }
}

function saveLocalState(current, completedArr) {
  lsSet(STATE_KEY, JSON.stringify({ current, completed: completedArr }));
}

function activeUser() {
  if (!firebaseReady || !auth) return null;
  return auth.currentUser || null;
}

// In-memory note cache keyed by noteKey (module-scoped string). Populated from Firestore on load.
const _notes = {};

export const store = {
  currentModule: 0,
  completed: new Set(),
  _loaded: false,
  _remoteUid: null, // uid whose data is currently in memory

  async load() {
    // Always pre-load from localStorage so we have something to render immediately.
    const local = loadLocalState();
    this.currentModule = local.current;
    this.completed = new Set(local.completed);

    const user = activeUser();
    if (!user) {
      this._loaded = true;
      this._remoteUid = null;
      return;
    }

    // Pull remote state.
    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      const progressCol = collection(db, 'users', user.uid, 'progress');
      const progressSnap = await getDocs(progressCol);

      const remoteCompleted = new Set();
      const remoteNotes = {};
      let hasAnyProgress = false;
      progressSnap.forEach((d) => {
        hasAnyProgress = true;
        const data = d.data() || {};
        const id = Number(d.id);
        if (data.completed) remoteCompleted.add(id);
        if (typeof data.notes === 'string' && data.notes.length) {
          remoteNotes[String(id)] = data.notes;
        }
      });

      const currentFromUserDoc = userSnap.exists() && typeof userSnap.data().currentModule === 'number'
        ? userSnap.data().currentModule
        : null;

      // Migration: first Firestore load and remote has no progress → push up local.
      if (!hasAnyProgress && (local.completed.length || this._hasLocalNotes())) {
        await this._migrateLocalToRemote(user.uid, local);
        // Re-use local as the truth we just pushed.
        this.currentModule = local.current;
        this.completed = new Set(local.completed);
      } else {
        this.completed = remoteCompleted;
        this.currentModule = currentFromUserDoc != null ? currentFromUserDoc : local.current;
        // Populate notes cache from remote.
        Object.keys(remoteNotes).forEach((k) => { _notes[`mod_${k}`] = remoteNotes[k]; });
      }

      this._remoteUid = user.uid;
      this._loaded = true;
      // Mirror into localStorage for offline.
      saveLocalState(this.currentModule, Array.from(this.completed));
    } catch (e) {
      console.warn('[store] remote load failed, falling back to localStorage:', e);
      this._loaded = true;
    }
  },

  _hasLocalNotes() {
    return lsKeys().some((k) => k && k.startsWith(NOTE_PREFIX));
  },

  async _migrateLocalToRemote(uid, local) {
    try {
      // Push each completed module as a progress doc. Module IDs are small integers.
      const writes = [];
      const completedSet = new Set(local.completed);
      const allIds = new Set([...completedSet]);
      // Also push any note keys that look like `mod_<n>`.
      lsKeys().forEach((k) => {
        if (!k || !k.startsWith(NOTE_PREFIX)) return;
        const bare = k.slice(NOTE_PREFIX.length);
        const m = bare.match(/^mod_(\d+)$/);
        if (m) allIds.add(Number(m[1]));
      });

      for (const id of allIds) {
        const notesKey = `${NOTE_PREFIX}mod_${id}`;
        const notesVal = lsGet(notesKey) || '';
        const payload = {
          completed: completedSet.has(id),
          notes: notesVal
        };
        if (completedSet.has(id)) payload.completedAt = serverTimestamp();
        writes.push(setDoc(doc(db, 'users', uid, 'progress', String(id)), payload, { merge: true }));
      }
      // Also write currentModule onto the user doc.
      writes.push(setDoc(doc(db, 'users', uid), {
        currentModule: local.current,
        lastActiveAt: serverTimestamp()
      }, { merge: true }));
      await Promise.all(writes);
    } catch (e) {
      console.warn('[store] migration failed:', e);
    }
  },

  setCurrent(id) {
    this.currentModule = id;
    saveLocalState(this.currentModule, Array.from(this.completed));
    const user = activeUser();
    if (user) {
      setDoc(doc(db, 'users', user.uid), {
        currentModule: id,
        lastActiveAt: serverTimestamp()
      }, { merge: true }).catch((e) => console.warn('[store] setCurrent remote write:', e));
      this._mirrorMemberDigest(user);
    }
  },

  markComplete(id) {
    this.completed.add(id);
    saveLocalState(this.currentModule, Array.from(this.completed));
    const user = activeUser();
    if (user) {
      setDoc(doc(db, 'users', user.uid, 'progress', String(id)), {
        completed: true,
        completedAt: serverTimestamp()
      }, { merge: true }).catch((e) => console.warn('[store] markComplete remote write:', e));
      setDoc(doc(db, 'users', user.uid), {
        lastActiveAt: serverTimestamp(),
        currentModule: this.currentModule
      }, { merge: true }).catch(() => {});
      this._mirrorMemberDigest(user);
    }
  },

  // Writes an aggregate digest (completedCount, lastActiveAt, public profile bits) to
  // companies/{companyId}/members/{uid} so company admins + peers can see progress/profile
  // without being granted read access on /progress subcollections (which stay private).
  async _mirrorMemberDigest(user) {
    try {
      const uDoc = await getDoc(doc(db, 'users', user.uid));
      if (!uDoc.exists()) return;
      const data = uDoc.data();
      const companyId = data.companyId;
      if (!companyId) return;
      await setDoc(doc(db, 'companies', companyId, 'members', user.uid), {
        uid: user.uid,
        email: user.email || data.email || null,
        displayName: data.displayName || user.displayName || null,
        avatarUrl: data.avatarUrl || null,
        bio: data.bio || null,
        role: data.role || 'user',
        completedCount: this.completed.size,
        currentModule: this.currentModule,
        lastActiveAt: serverTimestamp()
      }, { merge: true });
    } catch (e) { /* best-effort */ }
  },

  isComplete(id) { return this.completed.has(id); }
};

export function saveNote(key, val) {
  _notes[key] = val;
  // Mirror to localStorage always.
  lsSet(NOTE_PREFIX + key, val);
  const user = activeUser();
  if (user) {
    // Expect keys shaped like `mod_<id>` or `mod_<id>_<slot>`. Store under progress/<id>.
    const m = key.match(/^mod_(\d+)(?:_.*)?$/);
    if (m) {
      const id = m[1];
      // If the key is a sub-slot (e.g. mod_3_reflection), stash under a nested map so we
      // don't overwrite the whole note.
      const sub = key.slice(`mod_${id}`.length).replace(/^_/, '');
      if (sub) {
        setDoc(doc(db, 'users', user.uid, 'progress', id), {
          noteSlots: { [sub]: val }
        }, { merge: true }).catch((e) => console.warn('[store] saveNote sub remote write:', e));
      } else {
        setDoc(doc(db, 'users', user.uid, 'progress', id), {
          notes: val
        }, { merge: true }).catch((e) => console.warn('[store] saveNote remote write:', e));
      }
    }
  }
}

export function getNotes(key) {
  if (_notes[key] != null) return _notes[key];
  const v = lsGet(NOTE_PREFIX + key);
  if (v != null) _notes[key] = v;
  return v || '';
}
