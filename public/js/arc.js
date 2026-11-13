// ARC Team page (/arc).
//
// Opens the application dialog from any book card, posts the application to
// the `submitArcApplication` callable, and shows the confirmation. Approval is
// manual: the server only records the application and emails it to Kailey.
//
// Firebase is imported lazily inside the submit handler, for the same reason as
// newsletter.js: if the CDN fetch fails at the top of a module, nothing below
// it runs and the page silently loses its nav and its dialog. Loaded on demand,
// a CDN problem becomes a visible error message instead.
//
// Deep link: /arc?book=<slug> opens the form for that book on load, so a
// TikTok or Instagram bio can point straight at one title.

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
// there is one copy to edit. promiseText is what the reader agreed to; it is
// sent with the application so the stored record matches what was on screen.
const promiseSource = $('arc-promise');
if (promiseSource) $('arc-promise-form').innerHTML = promiseSource.innerHTML;
const promiseText = promiseSource
  ? [...promiseSource.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()).join(' | ')
  : '';

let opener = null;
let busy = false;

function setNote(message, state) {
  note.textContent = message;
  note.dataset.state = state || '';
}

function openFor(card, trigger) {
  if (!card) return;
  opener = trigger || null;

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

  try {
    let functions, firebaseReady, httpsCallable;
    try {
      [{ functions, firebaseReady }, { httpsCallable }] = await Promise.all([
        import('./firebase.js'),
        import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js')
      ]);
    } catch (e) {
      throw new Error('offline');
    }
    if (!firebaseReady) throw new Error('offline');

    await httpsCallable(functions, 'submitArcApplication')({
      book: bookInput.value, name, email, platforms, website,
      agree: true, promiseText
    });

    form.hidden = true;
    thanks.hidden = false;
    thanks.focus();
    if (typeof gtag === 'function') gtag('event', 'arc_application', { book: bookInput.value });
  } catch (error) {
    const code = (error && error.code) || '';
    const offline = error && error.message === 'offline';
    const message = offline
      ? 'Applications are offline right now. Please try again in a moment.'
      : code === 'functions/invalid-argument'
        ? (error.message || 'Something in the form was not accepted. Check it and try again.')
        : code === 'functions/resource-exhausted'
          ? 'Too many attempts just now. Please try again in a few minutes.'
          : 'Could not send your application just now. Please try again shortly.';
    setNote(message, 'error');
    submitBtn.disabled = false;
    submitBtn.firstChild.textContent = submitLabel;
    busy = false;
  }
});

// ── Deep link ────────────────────────────────────────────────────────────
const wanted = new URLSearchParams(location.search).get('book');
if (wanted) {
  const card = [...document.querySelectorAll('.arc-book')].find((c) => c.dataset.book === wanted);
  if (card) openFor(card, card.querySelector('.arc-cover'));
}
