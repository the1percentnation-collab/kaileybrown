// ARC Team page (/arc).
//
// Opens the application dialog from any book card, sends the application to
// Kailey's Kit account, and shows the confirmation.
//
// How an application travels: it is posted to the Kit form "ARC Application"
// (the same public endpoint Kit's own embed code posts to, so no key lives in
// this file). Kit creates the reader as a subscriber and tags them
// "ARC Applicant: <Book>". Kailey reviews applicants under that tag in Kit and
// approves by hand. Nothing is sent to the reader automatically.
//
// The tags and custom fields below were created in Kit for this page. If one
// is deleted or renamed there, applications still arrive but lose that detail.
//
// Deep link: /arc?book=<slug> opens the form for that book on load, so a
// TikTok or Instagram bio can point straight at one title.

const KIT_FORM_ID = '10183976';                       // Kit form: "ARC Application"
const KIT_ENDPOINT = `https://app.kit.com/forms/${KIT_FORM_ID}/subscriptions`;
// Kit tag IDs, one "ARC Applicant: <Book>" tag per book slug on this page.
const KIT_TAGS = {
  'somewhere-between-dreaming-and-you': '25808851',
  'landed-on-you': '25808852',
  '12-days-of-awkward': '25808853',
  'mafia-romance': '25808854',
  'copperridge-3': '25808855'
};
const PLATFORM_LABELS = { amazon: 'Amazon', goodreads: 'Goodreads' };

const $ = (id) => document.getElementById(id);
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Chrome shared with the home page ─────────────────────────────────────
$('year').textContent = new Date().getFullYear();

const burger = $('hamburger');
const navLinks = $('nav-links');
burger.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  burger.setAttribute('aria-expanded', String(open));
});
navLinks.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') {
    navLinks.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
  }
});

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px' });
  document.querySelectorAll('.fade-up, .section-head').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.fade-up, .section-head').forEach((el) => el.classList.add('is-in'));
}

// ── Application dialog ───────────────────────────────────────────────────
const modal = $('arc-modal');
const form = $('arc-form');
const note = $('arc-note');
const thanks = $('arc-thanks');
const titleEl = $('arc-modal-title');
const coverEl = $('arc-modal-cover');
const synopsisEl = $('arc-modal-synopsis');
const bookInput = $('arc-book');
const submitBtn = form.querySelector('button[type="submit"]');
const submitLabel = submitBtn.firstChild.textContent;
const agreeInput = $('arc-agree');

// The form shows the same ARC Promise as the page section, copied from it so
// there is one copy to edit.
const promiseSource = $('arc-promise');
if (promiseSource) $('arc-promise-form').innerHTML = promiseSource.innerHTML;

let opener = null;
let busy = false;

function setNote(message, state) {
  note.textContent = message;
  note.dataset.state = state || '';
}

function openFor(card, trigger) {
  if (!card) return;
  opener = trigger || null;

  modal.classList.remove('no-cover');
  bookInput.value = card.dataset.book;
  titleEl.textContent = card.dataset.title;
  // Static markup from this page's own cards, never user input.
  const front = card.querySelector('.arc-front');
  coverEl.innerHTML = front ? front.outerHTML : '';
  const synopsis = card.querySelector('.arc-synopsis');
  synopsisEl.innerHTML = synopsis ? synopsis.innerHTML : '';

  // Each opening starts fresh, but keep name and email if the reader is
  // applying for a second book.
  form.hidden = false;
  thanks.hidden = true;
  form.querySelectorAll('input[name="platforms"]').forEach((c) => { c.checked = false; });
  agreeInput.checked = false;
  form.querySelector('.promise-box').open = false;
  setNote('', '');
  submitBtn.disabled = false;
  submitBtn.firstChild.textContent = submitLabel;
  busy = false;

  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
  modal.scrollTop = 0;

  // Desktop gets the name field focused; on a phone that would throw the
  // keyboard up over the synopsis before the reader has seen what they chose.
  if (matchMedia('(hover: hover)').matches) $('arc-name').focus();
  else titleEl.focus();
}

function close() {
  if (typeof modal.close === 'function') modal.close();
  else modal.removeAttribute('open');
}

modal.addEventListener('close', () => {
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
  // Drop ?book= so a refresh does not reopen the form.
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
});

// A click on the dimmed backdrop lands on the dialog element itself.
modal.addEventListener('click', (e) => {
  if (e.target === modal) close();
  if (e.target.closest('[data-close]')) close();
});

$('arc-grid').addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-apply]');
  if (!trigger) return;
  openFor(trigger.closest('.arc-book'), trigger);
});

// ── Submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;

  const name = $('arc-name').value.trim();
  const email = $('arc-email').value.trim();
  const platforms = [...form.querySelectorAll('input[name="platforms"]:checked')].map((c) => c.value);
  const website = form.elements.website.value;

  if (!name) { setNote('Please enter your name.', 'error'); $('arc-name').focus(); return; }
  if (!LOOKS_LIKE_EMAIL.test(email)) {
    setNote('That email address does not look right. Check it and try again.', 'error');
    $('arc-email').focus();
    return;
  }
  if (!platforms.length) {
    setNote('Choose where you will post your review: Amazon, Goodreads, or both.', 'error');
    form.querySelector('input[name="platforms"]').focus();
    return;
  }

  if (!agreeInput.checked) {
    setNote('Please agree to the ARC Promise to apply.', 'error');
    agreeInput.focus();
    return;
  }

  busy = true;
  submitBtn.disabled = true;
  submitBtn.firstChild.textContent = 'Sending...';
  setNote('', '');

  // Honeypot: a field real readers never see. A bot that fills it gets the
  // same thank-you a person would and nothing is sent.
  if (website.trim()) { showThanks(); return; }

  const tagId = KIT_TAGS[bookInput.value];
  if (!tagId) {
    setNote('Please close this form and choose a book to apply for.', 'error');
    resetSubmit();
    return;
  }

  // Field names are Kit's own: email_address, fields[<custom field key>] and
  // tags[]. A plain form post with only an Accept header is a "simple" request,
  // so the browser sends it without a preflight.
  const body = new FormData();
  body.append('email_address', email);
  body.append('fields[first_name]', name);
  body.append('fields[arc_review_platforms]', platforms.map((p) => PLATFORM_LABELS[p] || p).join(', '));
  body.append('fields[arc_promise_agreed]', 'Yes, ' + new Date().toISOString().slice(0, 10));
  body.append('tags[]', tagId);

  try {
    let res;
    try {
      res = await fetch(KIT_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json' }, body });
    } catch (e) {
      throw new Error('offline');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON reply, judged by status below */ }

    const status = data && data.status;

    // Kit sometimes asks for a quick "are you human" check before it accepts a
    // sign-up. It answers "quarantined" with the address of that check; the
    // application is only recorded once the reader passes it. Kit's own embed
    // code handles this the same way, by sending the reader there. The book is
    // remembered so the thank-you can greet them when Kit sends them back to
    // /arc?applied=1 (set as the form's redirect in Kit).
    if (res.ok && status === 'quarantined' && typeof data.url === 'string' && data.url.startsWith('https://app.kit.com/')) {
      try { sessionStorage.setItem('arcPendingBook', bookInput.value); } catch (e) { /* private mode */ }
      setNote('One last step: a quick security check to confirm you are a real reader. Taking you there now.', 'ok');
      setTimeout(() => { location.href = data.url; }, 1600);
      return;
    }
    if (!res.ok || (status && status !== 'success')) {
      const detail = data && data.errors && (data.errors.messages || data.errors);
      const err = new Error(Array.isArray(detail) ? detail.join(' ') : 'rejected');
      err.rejected = true;
      throw err;
    }

    showThanks();
    if (typeof gtag === 'function') gtag('event', 'arc_application', { book: bookInput.value });
  } catch (error) {
    const message = error && error.message === 'offline'
      ? 'Could not reach the sign-up service. Check your connection and try again.'
      : 'Could not send your application just now. Please try again shortly, or email Kaileybrown.author@gmail.com.';
    setNote(message, 'error');
    resetSubmit();
  }
});

function showThanks() {
  form.hidden = true;
  thanks.hidden = false;
  thanks.focus();
}

function resetSubmit() {
  submitBtn.disabled = false;
  submitBtn.firstChild.textContent = submitLabel;
  busy = false;
}

// A reader coming back with the browser's Back button from Kit's security
// check finds the page restored from cache with the button still disabled.
addEventListener('pageshow', (e) => { if (e.persisted) { resetSubmit(); setNote('', ''); } });

// ── Deep link and return from Kit ────────────────────────────────────────
const params = new URLSearchParams(location.search);

// /arc?applied=1 is where Kit sends a reader after its security check, or
// after any sign-up if the form's redirect is set. Show the thank-you.
if (params.get('applied')) {
  let pending = null;
  try { pending = sessionStorage.getItem('arcPendingBook'); sessionStorage.removeItem('arcPendingBook'); } catch (e) { /* private mode */ }
  const card = pending && [...document.querySelectorAll('.arc-book')].find((c) => c.dataset.book === pending);
  if (card) {
    openFor(card, card.querySelector('.arc-cover'));
  } else {
    modal.classList.add('no-cover');
    titleEl.textContent = 'Thank you';
    coverEl.innerHTML = '';
    synopsisEl.innerHTML = '';
    if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open', '');
  }
  showThanks();
}

const wanted = params.get('book');
if (wanted && !params.get('applied')) {
  const card = [...document.querySelectorAll('.arc-book')].find((c) => c.dataset.book === wanted);
  if (card) openFor(card, card.querySelector('.arc-cover'));
}
