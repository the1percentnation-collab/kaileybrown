// consent-banner.js — lightweight cookie/analytics consent notice.
//
// Plain (non-module) script so it can be dropped onto any page with a single
// <script src="/js/consent-banner.js" defer></script> tag. Shows a one-time
// banner until the visitor accepts or declines, stores the choice in
// localStorage, and (when declined) sets Google Analytics consent to denied
// via the gtag consent API if gtag is present.
(function () {
  'use strict';
  var KEY = 'cookieConsent'; // 'accepted' | 'declined'

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ }
  }

  // Apply GA consent state if the gtag consent API is available.
  function applyConsent(choice) {
    if (typeof window.gtag !== 'function') return;
    var granted = choice === 'accepted' ? 'granted' : 'denied';
    try {
      window.gtag('consent', 'update', {
        ad_storage: granted,
        analytics_storage: granted,
        ad_user_data: granted,
        ad_personalization: granted
      });
    } catch (e) { /* ignore */ }
  }

  function build() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.style.cssText = [
      'position:fixed', 'left:16px', 'right:16px', 'bottom:16px', 'z-index:99999',
      'max-width:720px', 'margin:0 auto', 'background:#FFFFFF', 'color:#3C3C3C',
      'border:1px solid rgba(0,0,0,.12)', 'border-radius:14px',
      'box-shadow:0 14px 36px rgba(0,0,0,.14)', 'padding:16px 18px',
      'font-family:Jost,system-ui,sans-serif', 'font-size:.95rem',
      'display:flex', 'flex-wrap:wrap', 'gap:12px', 'align-items:center',
      'justify-content:space-between'
    ].join(';');

    var text = document.createElement('div');
    text.style.cssText = 'flex:1 1 320px;line-height:1.5;';
    text.innerHTML = 'We use cookies for sign-in and to measure site usage. See our ' +
      '<a href="/privacy.html" style="color:#C8102E;">Privacy Policy</a>. ' +
      'You can accept analytics cookies or decline non-essential ones.';

    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px;flex:0 0 auto;';

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = 'Decline';
    decline.style.cssText = 'padding:9px 16px;border-radius:9px;border:1px solid rgba(0,0,0,.18);background:transparent;color:#1A1A1A;cursor:pointer;font-weight:600;';

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'Accept';
    accept.style.cssText = 'padding:9px 18px;border-radius:9px;border:none;background:#C8102E;color:#fff;cursor:pointer;font-weight:700;';

    function close(choice) {
      save(choice);
      applyConsent(choice);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }
    accept.addEventListener('click', function () { close('accepted'); });
    decline.addEventListener('click', function () { close('declined'); });

    btns.appendChild(decline);
    btns.appendChild(accept);
    bar.appendChild(text);
    bar.appendChild(btns);
    return bar;
  }

  function init() {
    var choice = stored();
    if (choice === 'accepted' || choice === 'declined') {
      applyConsent(choice); // re-apply on each load
      return;
    }
    document.body.appendChild(build());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
