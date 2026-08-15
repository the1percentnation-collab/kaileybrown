// Certificate of completion — the shared pieces used by the in-course player,
// the course roadmap and the printable sheet on /certificate.html.
//
// Everything here is markup + pure functions. Reading progress lives in
// course-progress.js; issuing the record lives in certificate-page.js.

// Local escaper rather than importing the player's — course-player.js imports
// this module, and a cycle here would be needless.
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const CERT_SIGNER = {
  name: 'Kailey Brown',
  title: 'Founder, Kailey Brown'
};

export function certificateHref(slug) {
  return `/certificate.html?course=${encodeURIComponent(slug)}`;
}

// ── Styles ────────────────────────────────────────────────────────────────
// Members pick which one they want to keep. The id becomes an `is-<id>` class
// on the sheet; the palette itself lives in CSS custom properties, so adding a
// style here plus a block in styles.css is the whole job. `sheet` and `accent`
// are only for the picker's swatch.

export const CERT_STYLES = [
  // Classic is the only style now, and it is the default: certificates get
  // printed, so a white sheet is correct regardless of screen theme, and the
  // old Midnight style burned a full page of toner. Dropped per manifest §5.3.
  { id: 'classic',  label: 'Classic',  sheet: '#FFFFFF', accent: '#C8102E' }
];

export const DEFAULT_CERT_STYLE = CERT_STYLES[0].id;

/** Falls back to the default for anything unrecognised (old or hand-edited values). */
export function normalizeCertStyle(id) {
  return CERT_STYLES.some((s) => s.id === id) ? id : DEFAULT_CERT_STYLE;
}

export function certStylePickerHtml(activeId) {
  const active = normalizeCertStyle(activeId);
  const buttons = CERT_STYLES.map((s) => `
    <button type="button" class="cert-style" data-style="${esc(s.id)}"
            aria-pressed="${s.id === active ? 'true' : 'false'}">
      <span class="cert-style-swatch" style="--sw-a:${esc(s.sheet)};--sw-b:${esc(s.accent)}"></span>
      ${esc(s.label)}
    </button>`).join('');
  return `
    <div class="cert-styles cert-noprint" role="group" aria-label="Certificate style">
      <span class="cert-styles-lbl">Style</span>
      ${buttons}
    </div>`;
}

// FNV-1a — small, stable, and dependency-free. Not a security primitive; it
// exists so the same member and course always produce the same number.
function hash36(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

/**
 * Certificate number, derived rather than stored, so a reprint always matches
 * the copy already in someone's hands even if the Firestore record is missing.
 */
export function certificateNumber(uid, slug) {
  const part = String(slug || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5) || 'COURSE';
  return `KB-${part}-${hash36(`${uid || 'anon'}::${slug || ''}`)}`;
}

export function formatCertDate(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// The standing paragraph under the course name — the award's wording, the same
// on every certificate the Academy issues.
const CERT_BODY = 'and demonstrated dedication to intentional growth, disciplined execution, ' +
  'and continuous improvement through Kailey Brown Academy. Your commitment reflects ' +
  'a practice of steady, deliberate progress.';

const CERT_TAGLINE = ['Clarity.', 'Intention.', 'Growth.'];

const ICON_CALENDAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' +
  '<path d="M7 14h2M11 14h2M15 14h2M7 17h2M11 17h2M15 17h2" stroke-linecap="round"/></svg>';

const ICON_SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<path d="M12 2.5 4 6v6c0 5 3.4 8.4 8 9.5 4.6-1.1 8-4.5 8-9.5V6l-8-3.5Z"/>' +
  '<path d="m12 8.6 1.1 2.2 2.4.35-1.75 1.7.41 2.4L12 14.1l-2.16 1.15.41-2.4-1.75-1.7 2.4-.35L12 8.6Z" fill="currentColor" stroke="none"/></svg>';

/**
 * The certificate itself — one self-contained block, so the page and any later
 * share or email surface all render the identical award.
 *
 * Everything inside scales off the sheet's own width (container query units),
 * which keeps the proportions of the design intact on a phone, on a desktop,
 * and on paper.
 */
export function certificateSheetHtml({
  name,
  courseTitle,
  dateLabel,
  certNumber,
  signer = CERT_SIGNER,
  style = DEFAULT_CERT_STYLE
} = {}) {
  return `
    <div class="cert-sheet is-${esc(normalizeCertStyle(style))}" id="cert-sheet">
      <div class="cert-frame">
        <div class="cert-face">
          <div class="cert-grid" aria-hidden="true"></div>
          <div class="cert-watermark" aria-hidden="true">KB</div>
          <div class="cert-hatch cert-hatch-tr" aria-hidden="true"></div>
          <div class="cert-hatch cert-hatch-bl" aria-hidden="true"></div>

          <div class="cert-inner">
            <div class="cert-brand">
              <div class="cert-brand-mark">KB</div>
              <div class="cert-brand-name">Kailey Brown</div>
              <div class="cert-brand-sub">Academy</div>
            </div>

            <div class="cert-ruled">This certifies that</div>

            <div class="cert-title">Certificate</div>
            <div class="cert-ruled is-red">of Completion</div>

            <div class="cert-name">${esc(name || 'Member')}</div>

            <div class="cert-lead">has successfully completed</div>
            <div class="cert-course">${esc(courseTitle || 'The Course')}</div>

            <p class="cert-body">${esc(CERT_BODY)}</p>

            <div class="cert-foot">
              <div class="cert-foot-col">
                <div class="cert-foot-icon">${ICON_CALENDAR}</div>
                <div class="cert-foot-val">${esc(dateLabel || '')}</div>
                <div class="cert-foot-lbl">Completion date</div>
              </div>
              <div class="cert-foot-col">
                <div class="cert-foot-icon">${ICON_SHIELD}</div>
                <div class="cert-foot-val is-mono">${esc(certNumber || '')}</div>
                <div class="cert-foot-lbl">Certificate ID</div>
              </div>
              <div class="cert-foot-col">
                <div class="cert-foot-sig">${esc(signer.name)}</div>
                <div class="cert-foot-lbl is-red">${esc(signer.name)}</div>
                <div class="cert-foot-lbl">${esc(signer.title)}</div>
              </div>
              <div class="cert-foot-col">
                <div class="cert-foot-sig is-monogram">KB</div>
                <div class="cert-foot-lbl is-red">Kailey Brown Academy</div>
                <div class="cert-foot-lbl">Certified Completion</div>
              </div>
            </div>

            <div class="cert-tagline">
              ${CERT_TAGLINE.map((t) => `<span>${esc(t)}</span>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * The "you finished" panel shown inside the course player once every module is
 * complete, and on the roadmap for a finished course.
 */
export function courseCompleteHtml({ href, courseTitle = '', compact = false } = {}) {
  return `
    <div class="course-done ${compact ? 'is-compact' : ''}">
      <div class="course-done-mark">★</div>
      <div class="course-done-text">
        <div class="course-done-eyebrow">Course complete</div>
        <h3 class="course-done-title">You finished${courseTitle ? ` ${esc(courseTitle)}` : ' the course'}.</h3>
        <p class="course-done-sub">Your certificate of completion is ready to view, print, or save as a PDF.</p>
      </div>
      <a class="course-done-btn" href="${esc(href)}">Get your certificate →</a>
    </div>`;
}
