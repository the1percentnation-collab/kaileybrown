// Course media uploads — shared by the course builder for lesson
// attachments, inline editor images, and uploaded lesson videos.
// Files land in Storage under courses/{slug}/{kind}/… (see storage.rules:
// admin-only writes, type + size hardening mirrored client-side here so
// admins get a friendly error instead of a rules rejection).

import { app, auth, firebaseReady } from './firebase.js';
import {
  getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// Lazy storage (only pages that upload pay the cost).
let _storage = null;
function storage() {
  if (!_storage && firebaseReady) _storage = getStorage(app);
  return _storage;
}

export const IMAGE_MAX = 10 * 1024 * 1024;
export const ATTACH_MAX = 25 * 1024 * 1024;
export const VIDEO_MAX = 500 * 1024 * 1024;

export const VIDEO_TYPES = ['video/mp4', 'video/webm'];

// Attachment allowlist — keep in sync with the contentType regex in
// storage.rules courses/{slug}/attachments.
const ATTACH_MIME = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\..*|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|text\/csv|text\/plain|application\/zip|application\/x-zip-compressed|image\/.*|audio\/.*)$/;

const KINDS = {
  images:      { max: IMAGE_MAX,  ok: (t) => /^image\//.test(t), label: 'an image (PNG, JPG, GIF, WebP…)' },
  attachments: { max: ATTACH_MAX, ok: (t) => ATTACH_MIME.test(t), label: 'a PDF, Word/Excel/PowerPoint file, CSV, text, ZIP, image, or audio file' },
  videos:      { max: VIDEO_MAX,  ok: (t) => VIDEO_TYPES.includes(t), label: 'an MP4 or WebM video' }
};

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

// "My Worksheet (v2).pdf" → "1699999999999-my-worksheet-v2.pdf" — path-safe
// and collision-proof (same Date.now() strategy as products.js).
export function safeFileName(name) {
  const raw = String(name || 'file');
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const base = (dot > 0 ? raw.slice(0, dot) : raw)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  return `${Date.now()}-${base}${ext ? '.' + ext : ''}`;
}

/**
 * uploadCourseFile(slug, kind, file, onProgress?) → Promise<meta>
 * kind ∈ 'images' | 'attachments' | 'videos'. Validates type + size, uploads
 * resumably (progress callbacks matter for large videos), and resolves
 * { name, url, path, size, type } ready to store on the module doc.
 */
export function uploadCourseFile(slug, kind, file, onProgress) {
  const spec = KINDS[kind];
  if (!spec) return Promise.reject(new Error(`Unknown upload kind: ${kind}`));
  if (!slug) return Promise.reject(new Error('No course selected.'));
  if (!auth.currentUser) return Promise.reject(new Error('Not signed in'));
  const s = storage();
  if (!s) return Promise.reject(new Error('Storage unavailable'));

  const type = file.type || '';
  if (!spec.ok(type)) {
    return Promise.reject(new Error(`"${file.name}" isn't a supported type — upload ${spec.label}.`));
  }
  if (file.size > spec.max) {
    return Promise.reject(new Error(`"${file.name}" is ${formatBytes(file.size)} — the limit is ${formatBytes(spec.max)}.`));
  }

  const path = `courses/${slug}/${kind}/${safeFileName(file.name)}`;
  const task = uploadBytesResumable(storageRef(s, path), file, { contentType: type });
  return new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => {
        if (onProgress && snap.totalBytes) {
          onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
        }
      },
      reject,
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve({ name: file.name, url, path, size: file.size, type });
        } catch (e) { reject(e); }
      }
    );
  });
}

// Best-effort Storage cleanup — the metadata on the module doc is the source
// of truth, so a failed delete (already gone, offline…) is not an error.
export async function deleteCourseFile(path) {
  if (!path) return;
  const s = storage();
  if (!s) return;
  try { await deleteObject(storageRef(s, path)); }
  catch (e) { console.warn('[course-uploads] delete failed', path, e && e.message); }
}
