// Newsletter signup — the primary call to action on the public site.
//
// Posts to the `joinEarlyAccess` callable with source 'newsletter', which
// upserts a CRM contact, tags it, and records the marketing consent with the
// wording the person actually saw. Nothing is stored client-side.
//
// Usage: give the form id="newsletter-form" with an email input inside it, and
// an element id="newsletter-note" for status text. Optionally include a text
// input named "name". Call init() once per page.

// Firebase is imported lazily inside the submit handler, NOT at the top of this
// module. A top-level import pulls the SDK from a CDN, and if that fetch fails
// the whole module fails to load, the submit listener never attaches, and the
// form silently reloads the page with no feedback at all. Loading it on demand
// means the handler always attaches and a CDN problem becomes a visible error
// message. It also keeps the SDK off the critical path of a marketing page that
// most visitors never submit.
const $ = (id) => document.getElementById(id);

// Deliberately loose. The server does the authoritative check; this only
// catches obvious typos before spending a round trip.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setNote(note, message, state) {
  if (!note) return;
  note.textContent = message;
  note.dataset.state = state || '';
}

export function init() {
  const form = $('newsletter-form');
  if (!form) return;

  const note = $('newsletter-note');
  const emailInput = form.querySelector('input[type="email"]');
  const nameInput = form.querySelector('input[name="name"]');
  const button = form.querySelector('button[type="submit"]');
  if (!emailInput) return;

  // The consent sentence shown next to the form. Sent to the server so the
  // stored consent record matches what was on screen, rather than a generic
  // string written months earlier.
  const consentEl = $('newsletter-consent');
  const consentText = consentEl ? consentEl.textContent.trim() : '';

  let busy = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const email = emailInput.value.trim();
    if (!LOOKS_LIKE_EMAIL.test(email)) {
      setNote(note, 'That email address does not look right. Check it and try again.', 'error');
      emailInput.focus();
      return;
    }

    busy = true;
    const originalLabel = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Adding you...'; }
    setNote(note, '', '');

    try {
      let functions, firebaseReady, httpsCallable;
      try {
        [{ functions, firebaseReady }, { httpsCallable }] = await Promise.all([
          import('./firebase.js'),
          import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js')
        ]);
      } catch (e) {
        // The SDK itself could not be fetched, which is the same thing as being
        // offline from the reader's point of view.
        throw new Error('offline');
      }
      if (!firebaseReady) throw new Error('offline');

      await httpsCallable(functions, 'joinEarlyAccess')({
        email,
        name: nameInput ? nameInput.value.trim() : '',
        consent: true,
        consentText,
        source: 'newsletter'
      });
      form.hidden = true;
      setNote(note, 'You are on the list. Watch your inbox.', 'ok');
    } catch (error) {
      // Surface the server's message when it is a real validation complaint,
      // otherwise keep it generic rather than leaking internals.
      const code = (error && error.code) || '';
      const offline = error && error.message === 'offline';
      const message = offline
        ? 'Signups are offline right now. Please try again in a moment.'
        : code === 'functions/invalid-argument'
          ? (error.message || 'That email address was not accepted.')
          : code === 'functions/resource-exhausted'
            ? 'Too many attempts just now. Please try again in a few minutes.'
            : 'Could not add you just now. Please try again shortly.';
      setNote(note, message, 'error');
      if (button) { button.disabled = false; button.textContent = originalLabel; }
      busy = false;
    }
  });
}
