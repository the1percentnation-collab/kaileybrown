// Lesson video embeds — turns a pasted YouTube / Vimeo / Loom URL into a safe
// iframe embed. Shared by the member course renderer (course-renderer.js) and
// the admin course builder (course-builder.js preview + validation).
//
// Security model: the embed src is CONSTRUCTED from a whitelisted host and a
// regex-validated video id — the raw pasted URL never reaches an iframe, and
// iframes are never allowlisted in DOMPurify. Unrecognized input → null/''.

function escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const YT_ID = /^[\w-]{6,20}$/;
const VIMEO_ID = /^\d{6,12}$/;
const LOOM_ID = /^[a-f0-9]{16,40}$/i;

function host(u) { return u.hostname.replace(/^www\./, '').toLowerCase(); }

/**
 * parseVideoUrl(raw) → { provider, id, embedSrc } | null
 * Accepts: youtube.com/watch?v=, youtu.be/, youtube.com/embed|shorts|live/,
 * vimeo.com/{id} (incl. player.vimeo.com/video/{id}), loom.com/share|embed/{id}.
 */
export function parseVideoUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch (e) { return null; }
  const h = host(u);
  const segs = u.pathname.split('/').filter(Boolean);

  // YouTube
  if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtube-nocookie.com') {
    let id = null;
    if (segs[0] === 'watch') id = u.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(segs[0])) id = segs[1];
    if (id && YT_ID.test(id)) {
      return { provider: 'youtube', id, embedSrc: `https://www.youtube-nocookie.com/embed/${id}` };
    }
    return null;
  }
  if (h === 'youtu.be') {
    const id = segs[0];
    if (id && YT_ID.test(id)) {
      return { provider: 'youtube', id, embedSrc: `https://www.youtube-nocookie.com/embed/${id}` };
    }
    return null;
  }

  // Vimeo — vimeo.com/{id}[/{hash}] or player.vimeo.com/video/{id}
  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const id = segs.find((p) => VIMEO_ID.test(p));
    if (id) return { provider: 'vimeo', id, embedSrc: `https://player.vimeo.com/video/${id}` };
    return null;
  }

  // Loom — loom.com/share/{id} or loom.com/embed/{id}
  if (h === 'loom.com') {
    if ((segs[0] === 'share' || segs[0] === 'embed') && segs[1]) {
      const id = segs[1].split('?')[0];
      if (LOOM_ID.test(id)) {
        return { provider: 'loom', id, embedSrc: `https://www.loom.com/embed/${id}` };
      }
    }
    return null;
  }

  return null;
}

/** videoEmbedHtml(raw) → responsive 16:9 iframe block, or '' when unparseable. */
export function videoEmbedHtml(raw) {
  const v = parseVideoUrl(raw);
  if (!v) return '';
  return `<div class="cp-video"><iframe src="${escAttr(v.embedSrc)}" title="Lesson video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
}

/**
 * videoFileHtml(videoFile) → native <video> block for an UPLOADED lesson
 * video ({ url, name, size, type } stored on the module doc), or '' when
 * unset. Like videoEmbedHtml, callers inject this OUTSIDE the
 * DOMPurify-sanitized lesson body — the src attribute is escaped and the
 * URL is admin-authored (Firebase Storage download URL).
 */
export function videoFileHtml(vf) {
  if (!vf || !vf.url) return '';
  return `<div class="cp-video is-file"><video controls preload="metadata" src="${escAttr(vf.url)}"></video></div>`;
}

/**
 * lessonVideoHtml(module) → the lesson's video block from either source.
 * An uploaded file takes precedence over a pasted provider link.
 */
export function lessonVideoHtml(m) {
  if (!m) return '';
  return videoFileHtml(m.videoFile) || videoEmbedHtml(m.videoUrl);
}

/** Short human label for the builder's validation hint ("YouTube video"…). */
export function providerLabel(raw) {
  const v = parseVideoUrl(raw);
  if (!v) return null;
  return { youtube: 'YouTube', vimeo: 'Vimeo', loom: 'Loom' }[v.provider];
}
