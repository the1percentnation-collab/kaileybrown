// Kailey Brown "Reading Room" — voice + text book-concierge widget.
// Matches the site's paper / ink / signal-red editorial system (tokens.css).
// The launcher is a detailed red book that opens — pages turning — on hover,
// echoing the page-turn hover the site's buttons already use.
// Animated sine-wave visualization, STT via Web Speech API, optional TTS.
// Call init() once per page.

import { functions } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

let _init = false;

export function init() {
  if (_init) return;
  _init = true;
  injectStyles();
  const root = buildWidget();
  document.body.appendChild(root);
  wireUp(root);
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

function buildWidget() {
  const root = document.createElement('div');
  root.id = 'kb-chat-widget';
  root.innerHTML = `
    <!-- Floating Action Button: the red book. Closed at rest; on hover (or
         while the panel is open) the front cover lifts and three leaves turn
         in sequence, caught mid-flight like a book being read. -->
    <button class="kb-fab" id="kb-fab" aria-label="Open the Reading Room — book help and resources" aria-expanded="false">
      <span class="kb-book" aria-hidden="true">
        <span class="kb-book-shadow"></span>
        <span class="kb-book-back"></span>
        <span class="kb-book-block"></span>
        <span class="kb-book-ribbon"></span>
        <span class="kb-page kb-page-3"></span>
        <span class="kb-page kb-page-2"></span>
        <span class="kb-page kb-page-1"></span>
        <span class="kb-book-cover">
          <span class="kb-cover-face">
            <span class="kb-cover-frame"></span>
            <span class="kb-cover-groove"></span>
            <span class="kb-cover-author">Kailey&nbsp;Brown</span>
            <span class="kb-cover-monogram">K<i class="kb-cover-dot">.</i></span>
            <span class="kb-cover-rule"></span>
          </span>
          <span class="kb-cover-inner"></span>
        </span>
      </span>
    </button>

    <!-- Chat Panel -->
    <div class="kb-panel" id="kb-panel" role="dialog" aria-modal="true" aria-label="The Reading Room — Kailey Brown book concierge">
      <!-- Header: the title page. "From the desk of" lockup, same as the nav
           wordmark, so the panel reads as a page of the site, not an app. -->
      <div class="kb-hdr">
        <div class="kb-hdr-left">
          <span class="kb-led" id="kb-led" aria-hidden="true"></span>
          <span class="kb-hdr-titles">
            <span class="kb-hdr-eyebrow">From the desk of</span>
            <span class="kb-hdr-title">The Reading Room</span>
          </span>
        </div>
        <div class="kb-hdr-right">
          <button class="kb-tts-btn" id="kb-tts-btn" aria-label="Toggle voice output" title="Toggle voice output">
            <svg class="kb-spk-on"  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <svg class="kb-spk-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          </button>
          <button class="kb-bug-btn" id="kb-bug-btn" aria-label="Report a bug" title="Report a bug">
            <!-- A caterpillar — the bookworm — climbing toward the head.
                 Body, head and eye are one path so fill-rule="evenodd" cuts
                 the eye as a real hole: it shows the button's own background,
                 so it stays correct through the hover tint instead of needing
                 a matching fill. Segments sit a hair apart rather than
                 overlapping, since evenodd would punch holes where filled
                 subpaths cross. -->
            <svg class="kb-bug-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
                d="M1.2,16.3a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z
                   M5.5,15.4a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z
                   M10.2,14.2a2.5,2.5 0 1,0 5,0a2.5,2.5 0 1,0 -5,0z
                   M14.4,12.2a3.4,3.4 0 1,0 6.8,0a3.4,3.4 0 1,0 -6.8,0z
                   M18.0,11.1a0.85,0.85 0 1,0 1.7,0a0.85,0.85 0 1,0 -1.7,0z"/>
              <g fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round">
                <!-- antennae -->
                <path d="M16.5,9.4 15.4,7.3"/>
                <path d="M19.4,9.2 20.2,7.1"/>
                <!-- legs -->
                <path d="M2.6,18.3 2.1,19.6"/>
                <path d="M7.4,17.6 7.0,18.9"/>
                <path d="M12.0,16.4 11.7,17.8"/>
              </g>
              <g fill="currentColor">
                <circle cx="15.1" cy="6.6" r="0.85"/>
                <circle cx="20.4" cy="6.4" r="0.85"/>
              </g>
            </svg>
            <span class="kb-bug-lbl">report bug</span>
          </button>
          <button class="kb-close" id="kb-close" aria-label="Close chat">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="1" y1="1" x2="13" y2="13"/>
              <line x1="13" y1="1" x2="1" y2="13"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Ink line: the wave reads as a pen stroke across the page. -->
      <div class="kb-viz" aria-hidden="true">
        <canvas id="kb-canvas" class="kb-canvas"></canvas>
        <div class="kb-viz-status" id="kb-viz-status">READY</div>
      </div>

      <!-- Messages -->
      <div class="kb-msgs" id="kb-msgs" role="log" aria-live="polite" aria-label="Conversation"></div>

      <!-- Book-resource shortcuts. Hidden once the reader starts typing. -->
      <div class="kb-chips" id="kb-chips" aria-label="Suggested questions">
        <button class="kb-chip" data-q="Which of Kailey's books should I start with?">Where do I start?</button>
        <button class="kb-chip" data-q="Where can I buy or download the books?">Get a copy</button>
        <button class="kb-chip" data-q="Do you have a reading guide or book club questions I can use with my group?">Reading guide</button>
        <button class="kb-chip" data-q="What free resources, worksheets or downloads come with the books?">Free resources</button>
        <button class="kb-chip" data-q="What is the next book about and when does it come out?">What's next</button>
      </div>

      <!-- Input bar -->
      <div class="kb-bar">
        <button class="kb-mic" id="kb-mic" aria-label="Voice input — click to speak" title="Click to speak">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8"  y1="23" x2="16" y2="23"/>
          </svg>
          <span class="kb-mic-ring" aria-hidden="true"></span>
        </button>
        <textarea
          id="kb-input"
          class="kb-input"
          placeholder="Ask about the books, a reading guide, an event…"
          rows="1"
          maxlength="2000"
          aria-label="Your message"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          inputmode="text"
        ></textarea>
        <button class="kb-send" id="kb-send" aria-label="Send message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  return root;
}

// ─── Logic ────────────────────────────────────────────────────────────────────

function wireUp(root) {
  const fab      = root.querySelector('#kb-fab');
  const panel    = root.querySelector('#kb-panel');
  const closeBtn = root.querySelector('#kb-close');
  const canvas   = root.querySelector('#kb-canvas');
  const vizStatus= root.querySelector('#kb-viz-status');
  const led      = root.querySelector('#kb-led');
  const msgs     = root.querySelector('#kb-msgs');
  const micBtn   = root.querySelector('#kb-mic');
  const input    = root.querySelector('#kb-input');
  const sendBtn  = root.querySelector('#kb-send');
  const ttsBtn   = root.querySelector('#kb-tts-btn');
  const bugBtn   = root.querySelector('#kb-bug-btn');
  const chips    = root.querySelector('#kb-chips');

  // ── State ──
  const S = { IDLE: 'idle', LISTEN: 'listen', THINK: 'think', SPEAK: 'speak' };
  const waveState = { v: S.IDLE, boost: 0 };
  let isOpen      = false;
  let loading     = false;
  let greeted     = false;
  let history     = [];
  let stopWave    = null;
  let voiceOut    = false; // TTS enabled flag

  function setS(s) {
    waveState.v = s;
    const labels = { idle: 'READY', listen: 'LISTENING…', think: 'PROCESSING…', speak: 'SPEAKING…' };
    vizStatus.textContent = labels[s] || 'READY';
    led.className = `kb-led kb-led-${s}`;
    micBtn.classList.toggle('kb-mic-active', s === S.LISTEN);
  }

  // ── TTS toggle ──
  ttsBtn.addEventListener('click', () => {
    voiceOut = !voiceOut;
    ttsBtn.classList.toggle('kb-tts-on', voiceOut);
  });

  // ── Bug report ──
  let bugFormEl = null;
  let html2canvasPromise = null;

  function loadHtml2Canvas() {
    if (html2canvasPromise) return html2canvasPromise;
    html2canvasPromise = new Promise((resolve, reject) => {
      if (window.html2canvas) { resolve(window.html2canvas); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('html2canvas failed to load'));
      document.head.appendChild(s);
    });
    return html2canvasPromise;
  }

  function showBugForm() {
    if (bugFormEl) return;
    loadHtml2Canvas().catch(() => {}); // pre-load in background
    bugFormEl = document.createElement('div');
    bugFormEl.className = 'kb-bug-form';
    bugFormEl.innerHTML = `
      <div class="kb-bug-form-lbl">Report a bug</div>
      <textarea class="kb-bug-ta" placeholder="Describe what happened…" rows="3" maxlength="1000"></textarea>
      <div class="kb-bug-acts">
        <button class="kb-bug-submit">Capture &amp; Submit</button>
        <button class="kb-bug-cancel">Cancel</button>
      </div>
    `;
    msgs.appendChild(bugFormEl);
    msgs.scrollTop = msgs.scrollHeight;
    bugFormEl.querySelector('.kb-bug-ta').focus();
    bugFormEl.querySelector('.kb-bug-cancel').addEventListener('click', () => {
      if (bugFormEl && bugFormEl.parentNode) bugFormEl.parentNode.removeChild(bugFormEl);
      bugFormEl = null;
    });
    bugFormEl.querySelector('.kb-bug-submit').addEventListener('click', submitBugReport);
  }

  async function submitBugReport() {
    if (!bugFormEl) return;
    const ta = bugFormEl.querySelector('.kb-bug-ta');
    const description = ta.value.trim();
    if (!description) { ta.focus(); return; }

    const submitBtn = bugFormEl.querySelector('.kb-bug-submit');
    const cancelBtn = bugFormEl.querySelector('.kb-bug-cancel');
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'Capturing…';

    let screenshotDataUrl = null;
    try {
      // Hide panel so the screenshot shows the page behind it
      panel.classList.remove('kb-open');
      await new Promise(r => setTimeout(r, 400));
      const h2c = await loadHtml2Canvas();
      const canvas = await h2c(document.body, {
        scale: 0.5,
        useCORS: true,
        logging: false,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        x: window.scrollX,
        y: window.scrollY,
        ignoreElements: (el) => el.id === 'kb-chat-widget'
      });
      screenshotDataUrl = canvas.toDataURL('image/jpeg', 0.72);
      panel.classList.add('kb-open');
    } catch (e) {
      console.warn('[chatbot] screenshot failed:', e);
      panel.classList.add('kb-open');
    }

    const descCopy = description;
    if (bugFormEl && bugFormEl.parentNode) bugFormEl.parentNode.removeChild(bugFormEl);
    bugFormEl = null;

    const thinkRow = addThinking();
    try {
      const call = httpsCallable(functions, 'reportBug');
      await call({
        description: descCopy,
        screenshotDataUrl,
        url: window.location.href,
        userAgent: navigator.userAgent
      });
      thinkRow.remove();
      const toast = document.createElement('div');
      toast.className = 'kb-profile-toast';
      toast.textContent = '✓ Bug report sent — thank you!';
      msgs.appendChild(toast);
      msgs.scrollTop = msgs.scrollHeight;
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6000);
    } catch (e) {
      console.error('[chatbot] bug report failed:', e);
      thinkRow.remove();
      addMsg('assistant', 'Bug report failed to send — please try again.', true);
    }
  }

  bugBtn.addEventListener('click', showBugForm);

  // ── Open / close ──
  function openPanel() {
    isOpen = true;
    panel.classList.add('kb-open');
    fab.setAttribute('aria-expanded', 'true');
    panel.removeAttribute('aria-hidden');
    // Start wave on first open (after layout is painted)
    if (!stopWave) requestAnimationFrame(() => { stopWave = startWave(canvas, waveState); });
    input.focus();
    if (!greeted) {
      greeted = true;
      setTimeout(() => addMsg('assistant', 'Welcome to the Reading Room. I can help you find the right book to start with, track down a copy, pull up reading guides and book-club questions, or point you to the free resources that go with each title. Ask away — or tap the mic and speak.'), 350);
    }
  }

  // ── Suggested-question chips ──
  // They are a starting nudge, so they retire the moment the reader engages:
  // one tap sends the question, and any typed message hides the row for good.
  function hideChips() {
    if (chips) chips.classList.add('kb-chips-gone');
  }
  if (chips) {
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.kb-chip');
      if (!chip) return;
      input.value = chip.dataset.q || chip.textContent.trim();
      hideChips();
      doSend();
    });
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('kb-open');
    fab.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
    stopListen();
    stopSpeak();
    fab.focus();
  }

  fab.addEventListener('click', () => isOpen ? closePanel() : openPanel());
  closeBtn.addEventListener('click', closePanel);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  // ── Auto-grow textarea ──
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
    // Spike wave on each character change
    waveState.boost = Math.min(waveState.boost + 4, 22);
  });
  input.addEventListener('keydown', (e) => {
    // Printable key check (length===1 excludes Enter, Backspace, Arrow, etc.)
    if (e.key.length === 1) waveState.boost = Math.min(waveState.boost + 3, 22);
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', doSend);

  // ── Mobile: shrink bottom sheet when keyboard opens ──
  if (window.visualViewport) {
    const onVp = () => {
      if (!window.matchMedia('(max-width: 600px)').matches) return;
      const maxH = Math.round(window.innerHeight * 0.85);
      panel.style.height = Math.min(window.visualViewport.height, maxH) + 'px';
      msgs.scrollTop = msgs.scrollHeight;
    };
    window.visualViewport.addEventListener('resize', onVp);
    window.visualViewport.addEventListener('scroll', onVp);
  }

  // ── Send ──
  async function doSend() {
    const text = input.value.trim();
    if (!text || loading) return;
    hideChips();
    input.value = '';
    input.style.height = 'auto';
    stopListen();
    stopSpeak();
    addMsg('user', text);
    history.push({ role: 'user', content: text });

    loading = true;
    sendBtn.disabled = true;
    setS(S.THINK);
    const thinkRow = addThinking();

    try {
      const call = httpsCallable(functions, 'courseAdvisorChat');
      const res  = await call({ message: text, history: history.slice(0, -1) });
      const reply = (res.data && res.data.reply) || 'Sorry, I didn\'t catch that. Please try again.';
      history.push({ role: 'assistant', content: reply });
      thinkRow.remove();
      addMsg('assistant', reply);

      // Show confirmation if the bot updated the member's profile.
      if (res.data && res.data.profileUpdated) {
        const fields = Object.keys(res.data.profileUpdated);
        if (fields.length) showProfileToast(fields);
      }

      if (voiceOut) {
        setS(S.SPEAK);
        await speakText(reply);
      }
      setS(S.IDLE);
    } catch (err) {
      console.error('[chatbot]', err);
      thinkRow.remove();
      addMsg('assistant', 'Something went wrong — please try again.', true);
      setS(S.IDLE);
    } finally {
      loading = false;
      sendBtn.disabled = false;
    }
  }

  // ── Message helpers ──
  function addMsg(role, text, isErr = false) {
    const row = document.createElement('div');
    row.className = `kb-row kb-row-${role}`;
    const bub = document.createElement('div');
    bub.className = `kb-bub kb-bub-${role}${isErr ? ' kb-bub-err' : ''}`;
    bub.textContent = text;
    row.appendChild(bub);
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function addThinking() {
    const row = document.createElement('div');
    row.className = 'kb-row kb-row-assistant';
    row.innerHTML = `<div class="kb-bub kb-bub-assistant kb-think-dots">
      <span class="kb-dot"></span><span class="kb-dot"></span><span class="kb-dot"></span>
    </div>`;
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function showProfileToast(fields) {
    const label = fields.length === 1
      ? fields[0].replace(/([A-Z])/g, ' $1').toLowerCase()
      : `${fields.length} profile fields`;
    const toast = document.createElement('div');
    toast.className = 'kb-profile-toast';
    toast.textContent = `✓ Profile saved — ${label} updated`;
    msgs.appendChild(toast);
    msgs.scrollTop = msgs.scrollHeight;
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5000);
  }

  // ── Voice input (STT) ──
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition  = null;
  let isListening  = false;

  if (!SpeechRec) {
    micBtn.style.display = 'none';
  } else {
    micBtn.addEventListener('click', () => isListening ? stopListen() : startListen());
  }

  function startListen() {
    if (!SpeechRec || loading) return;
    stopSpeak();
    isListening = true;
    voiceOut    = true; // Auto-enable TTS when user uses voice
    ttsBtn.classList.add('kb-tts-on');
    setS(S.LISTEN);

    recognition = new SpeechRec();
    recognition.continuous     = false;
    recognition.interimResults = true;
    recognition.lang           = 'en-US';

    recognition.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      input.value = final || interim;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 112) + 'px';
      if (final) setTimeout(doSend, 180);
    };

    recognition.onend = () => {
      isListening = false;
      if (waveState.v === S.LISTEN) setS(S.IDLE);
    };
    recognition.onerror = (e) => {
      console.warn('[chatbot] STT error:', e.error);
      isListening = false;
      if (waveState.v === S.LISTEN) setS(S.IDLE);
    };

    try { recognition.start(); }
    catch (e) { console.warn('[chatbot] recognition start:', e); isListening = false; setS(S.IDLE); }
  }

  function stopListen() {
    isListening = false;
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    if (waveState.v === S.LISTEN) setS(S.IDLE);
  }

  // ── Voice output (TTS) ──
  let curUtterance = null;

  function speakText(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || !text) { resolve(); return; }
      stopSpeak();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 0.97; utt.pitch = 1.0; utt.volume = 1.0;
      const pickVoice = () => {
        const voices = speechSynthesis.getVoices();
        return voices.find(v => /en-US/i.test(v.lang) && /google/i.test(v.name))
            || voices.find(v => /en-US/i.test(v.lang))
            || voices.find(v => /en/i.test(v.lang))
            || null;
      };
      const start = () => {
        const voice = pickVoice();
        if (voice) utt.voice = voice;
        utt.onend   = resolve;
        utt.onerror = resolve;
        curUtterance = utt;
        speechSynthesis.speak(utt);
      };
      if (speechSynthesis.getVoices().length) {
        start();
      } else {
        speechSynthesis.addEventListener('voiceschanged', start, { once: true });
      }
    });
  }

  function stopSpeak() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    curUtterance = null;
    if (waveState.v === S.SPEAK) setS(S.IDLE);
  }
}

// ─── Wave Canvas ──────────────────────────────────────────────────────────────

function startWave(canvas, stateRef) {
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth  || 360;
  const cssH = canvas.clientHeight || 80;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  let frame   = 0;
  let amp     = 4;  // target amplitude tracker
  let liveAmp = 4;  // smoothed amplitude that actually drives drawing
  let raf;

  // Per-state config — gentler speeds, softer amplitudes
  const CFG = {
    idle:   { targetAmp: 4,  speed: 0.011 },
    listen: { targetAmp: 22, speed: 0.048 },
    think:  { targetAmp: 10, speed: 0.030 },
    speak:  { targetAmp: 16, speed: 0.042 },
  };

  function draw() {
    const s   = stateRef.v;
    const cfg = CFG[s] || CFG.idle;
    const W   = cssW, H = cssH;

    // Slowly decay typing boost (~1.5 s at 60 fps)
    if (stateRef.boost > 0) {
      stateRef.boost *= 0.94;
      if (stateRef.boost < 0.15) stateRef.boost = 0;
    }

    // Drive the raw amplitude toward the state target
    amp += (Math.min(cfg.targetAmp + stateRef.boost, 38) - amp) * 0.05;

    // liveAmp follows amp with extra lag so nothing ever jumps
    liveAmp += (amp - liveAmp) * 0.10;

    let a = liveAmp;
    // Gentle breathing while thinking (organic, no randomness)
    if (s === 'think')  a *= 0.62 + 0.38 * Math.sin(frame * 0.042);
    // Organic variation while listening — two slow oscillators, no Math.random
    if (s === 'listen') a *= 0.78 + 0.15 * Math.sin(frame * 0.07) + 0.07 * Math.sin(frame * 0.13 + 1.1);

    ctx.clearRect(0, 0, W, H);

    // Filled area under primary wave
    const fillGrad = ctx.createLinearGradient(0, H * 0.35, 0, H);
    fillGrad.addColorStop(0, 'rgba(227,24,55,0.14)');
    fillGrad.addColorStop(1, 'rgba(227,24,55,0)');
    ctx.save();
    ctx.beginPath();
    wave(ctx, W, H, a, cfg.speed, frame, 0);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.restore();

    // Wave layers: red pen stroke, its lighter echo, and a faint ink trace.
    // On paper the third layer has to be dark (it was white for the old black
    // panel) or it disappears into the page.
    strokeWave(ctx, W, H, a,        cfg.speed, frame, 0,             '#E31837',              1.00, 2.0);
    strokeWave(ctx, W, H, a * 0.60, cfg.speed, frame, Math.PI / 2.2, 'rgba(163,46,58,.42)',  1.00, 1.3);
    strokeWave(ctx, W, H, a * 0.28, cfg.speed, frame, Math.PI,       'rgba(26,26,26,.13)',   1.00, 1.0);

    // Center rule — the ruled line of the page
    ctx.save();
    ctx.globalAlpha = 0.20 + 0.12 * Math.sin(frame * 0.05);
    ctx.strokeStyle = '#1A1A1A';
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.restore();

    frame++;
    raf = requestAnimationFrame(draw);
  }

  draw();
  return () => cancelAnimationFrame(raf);
}

function wave(ctx, W, H, amp, speed, frame, phase) {
  ctx.beginPath();
  for (let x = 0; x <= W; x += 2) {
    // Three harmonically-related frequencies → organic voice-like shape
    const y = H / 2 + (
      Math.sin(x * 0.019 + frame * speed          + phase) * amp * 0.55 +
      Math.sin(x * 0.034 + frame * speed * 1.31   + phase * 1.2) * amp * 0.30 +
      Math.sin(x * 0.011 + frame * speed * 0.62   + phase * 0.6) * amp * 0.15
    );
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
}

function strokeWave(ctx, W, H, amp, speed, frame, phase, color, alpha, lw) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineJoin    = 'round';
  wave(ctx, W, H, amp, speed, frame, phase);
  ctx.stroke();
  ctx.restore();
}


// ─── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('kb-chat-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-chat-css';
  el.textContent = `
/* ═══════════════════════════════════════════════════════════════════════════
   THE READING ROOM — book concierge widget

   Skinned from tokens.css: white paper, near-black ink, one signal red.
   Every colour goes through a token with a literal fallback, so the widget
   follows a palette change and still renders on pages that predate tokens.

   The widget mounts on <body>, outside any .on-black scope, so it always
   resolves the light roles even on the portal pages whose rails are black.
   ═══════════════════════════════════════════════════════════════════════════ */

#kb-chat-widget {
  position: fixed;
  bottom: 28px;
  right: 28px;
  z-index: 9999;
  font-family: var(--font-body, 'Jost', system-ui, sans-serif);

  /* Local aliases. Declared here rather than read from :root at each call
     site so the fallbacks live in exactly one place. */
  --kb-paper:  var(--paper, #FFFFFF);
  --kb-surf:   var(--surface, #FAFAFA);
  --kb-surf2:  var(--surface-2, #F1F1F1);
  --kb-ink:    var(--ink, #1A1A1A);
  --kb-ink-hi: var(--ink-strong, #000000);
  --kb-muted:  var(--ink-muted, #6E6E6E);
  --kb-line:   var(--border, rgba(0,0,0,.14));
  --kb-red:    var(--red, #E31837);
  --kb-red-dk: var(--red-dark, #B80D28);
  --kb-red-mu: var(--red-muted, #A32E3A);
  --kb-tint:   var(--red-tint, rgba(227,24,55,.08));
  --kb-label:  var(--font-body, 'Jost', system-ui, sans-serif);
  --kb-ease:   var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));

  /* Board colours for the book itself — deeper than signal red so the
     launcher reads as a cloth binding, not a button. */
  --kb-board:  #C0122E;
  --kb-board-2:#8E2733;
  --kb-leaf:   #FBFAF6;
  --kb-leaf-2: #EDE9DF;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE LAUNCHER — a book that opens

   Built from stacked 3-D layers rather than an image so it inherits the
   palette and stays crisp at any density: back board, text block, three
   leaves and a front board, all hinged on a left-edge spine.

   At rest the book is closed and squarely presented. On hover — or whenever
   the panel is open — the front board swings open and the leaves turn in
   sequence, on a loop, so the book reads as being actively read. Each leaf
   fades out while face-away and fades back in flat, which hides the reset
   and makes three leaves look like an endless stack.
   ═══════════════════════════════════════════════════════════════════════════ */

.kb-fab {
  position: relative;
  /* Sized so the cover's stamped type still resolves: below about this the
     author line degrades into texture rather than reading as a name. */
  width: 86px;
  height: 92px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  perspective: 800px;
  -webkit-tap-highlight-color: transparent;
}
.kb-fab:focus-visible { outline: 2px solid var(--kb-red); outline-offset: 6px; }

.kb-book {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  /* A slight tilt away and to the left: the book sits on a desk, seen from
     just above, rather than floating flat-on like an icon. */
  transform: rotateX(12deg) rotateZ(-3deg);
  transition: transform .5s var(--kb-ease);
}
.kb-fab:hover .kb-book,
.kb-fab:focus-visible .kb-book,
.kb-fab[aria-expanded="true"] .kb-book {
  transform: rotateX(6deg) rotateZ(0deg) scale(1.05);
}
.kb-fab:active .kb-book { transform: rotateX(10deg) scale(.97); }

.kb-book > span { position: absolute; }

/* Contact shadow on the desk. It spreads as the book opens. */
.kb-book-shadow {
  left: 10px; right: 8px; bottom: 3px; height: 13px;
  background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,.30), rgba(0,0,0,0) 70%);
  filter: blur(2px);
  transform: translateZ(-6px);
  transition: transform .5s var(--kb-ease), opacity .5s var(--kb-ease);
}
.kb-fab:hover .kb-book-shadow,
.kb-fab[aria-expanded="true"] .kb-book-shadow { transform: translateZ(-6px) scaleX(1.35); opacity: .8; }

/* Back board — the half of the binding that stays put. */
.kb-book-back {
  left: 16px; right: 14px; top: 8px; bottom: 8px;
  background: linear-gradient(115deg, var(--kb-board-2), var(--kb-board) 60%, var(--kb-board-2));
  border-radius: 2px 4px 4px 2px;
  box-shadow: 0 6px 16px rgba(0,0,0,.32), inset -1px 0 0 rgba(0,0,0,.25);
}

/* Text block — the fore-edge of the paper, ruled with page striations so
   you can count leaves at the edge. */
/* The striations are the fore-edge only — the outer few millimetres of the
   right side, where the stacked leaves are actually visible. Run them across
   the whole face and the open book reads as corduroy, not paper. */
.kb-book-block {
  left: 18px; right: 16px; top: 10px; bottom: 10px;
  border-radius: 1px 3px 3px 1px;
  background:
    linear-gradient(90deg, rgba(0,0,0,0) calc(100% - 7px), rgba(0,0,0,.05) 100%),
    repeating-linear-gradient(90deg,
      var(--kb-leaf) 0 2px,
      var(--kb-leaf-2) 2px 3px) right / 7px 100% no-repeat,
    linear-gradient(100deg, #FFFDF8, var(--kb-leaf) 60%, var(--kb-leaf-2));
  box-shadow: inset 0 -1px 0 rgba(0,0,0,.14), inset 1px 0 0 rgba(0,0,0,.10);
}

/* Place-keeper ribbon, tucked into the spine and trailing past the tail.
   It lies between the leaves and the front board, so it must NOT be lifted
   in Z — a translateZ here floats it in front of the closed cover. It reads
   as a ribbon only once the board has opened. */
.kb-book-ribbon {
  left: 27px; top: 14px; width: 5px; bottom: 3px;
  background: linear-gradient(var(--kb-red), var(--kb-red-mu));
  border-radius: 0 0 2px 2px;
  box-shadow: 0 1px 3px rgba(0,0,0,.28);
}

/* ── Leaves ─────────────────────────────────────────────────────────────
   Hinged at the spine. The faint rules read as lines of type at this size;
   the right-edge shading is the curl catching the light as it lifts. */
.kb-page {
  left: 17px; right: 15px; top: 9px; bottom: 9px;
  transform-origin: left center;
  transform: rotate3d(0.12, 1, 0, 0deg);
  backface-visibility: hidden;
  border-radius: 1px 3px 3px 1px;
  background:
    linear-gradient(90deg, rgba(0,0,0,.14) 0 2px, rgba(0,0,0,0) 6px),
    repeating-linear-gradient(180deg,
      rgba(0,0,0,0) 0 5px,
      rgba(26,26,26,.16) 5px 6px),
    linear-gradient(100deg, #FFFDF8, var(--kb-leaf) 55%, var(--kb-leaf-2));
  background-size: 100% 100%, 60% 62%, 100% 100%;
  background-position: 0 0, 22% 50%, 0 0;
  background-repeat: no-repeat, no-repeat, no-repeat;
  box-shadow: 0 0 0 rgba(0,0,0,0);
}
.kb-fab:hover .kb-page,
.kb-fab:focus-visible .kb-page,
.kb-fab[aria-expanded="true"] .kb-page {
  animation: kb-leaf-turn 2.1s cubic-bezier(.42,.02,.35,1) infinite;
}
.kb-page-1 { animation-delay: .10s; }
.kb-page-2 { animation-delay: .80s; }
.kb-page-3 { animation-delay: 1.50s; }

@keyframes kb-leaf-turn {
  0%   { transform: rotate3d(0.12, 1, 0, 0deg);    opacity: 1; box-shadow: 0 0 0 rgba(0,0,0,0); }
  8%   { box-shadow: 10px 6px 20px rgba(0,0,0,.30); }
  46%  { transform: rotate3d(0.12, 1, 0, -152deg); opacity: 1; }
  /* Past square the leaf is face-away and clipped by backface-visibility,
     so fading out here hides the snap back to flat entirely. */
  56%  { transform: rotate3d(0.12, 1, 0, -172deg); opacity: 0; box-shadow: 0 0 0 rgba(0,0,0,0); }
  57%  { transform: rotate3d(0.12, 1, 0, 0deg);    opacity: 0; }
  72%  { opacity: 0; }
  86%  { opacity: 1; }
  100% { transform: rotate3d(0.12, 1, 0, 0deg);    opacity: 1; }
}

/* ── Front board ────────────────────────────────────────────────────────
   Two faces on one hinge: the cloth cover, and the cream endpaper you see
   once it has swung past square. */
.kb-book-cover {
  left: 16px; right: 14px; top: 8px; bottom: 8px;
  transform-origin: left center;
  transform-style: preserve-3d;
  transform: rotate3d(0.1, 1, 0, 0deg);
  transition: transform .62s cubic-bezier(0.4, 0.1, 0.22, 1);
}
.kb-fab:hover .kb-book-cover,
.kb-fab:focus-visible .kb-book-cover,
.kb-fab[aria-expanded="true"] .kb-book-cover {
  transform: rotate3d(0.1, 1, 0, -158deg);
}
/* The lift shadow lives on the faces, never on this hinge element: a filter
   here flattens the preserve-3d subtree, which switches off backface-
   visibility and leaves the open board showing a mirrored front cover
   instead of its endpaper. */
.kb-fab:hover .kb-cover-face,
.kb-fab:focus-visible .kb-cover-face,
.kb-fab[aria-expanded="true"] .kb-cover-face,
.kb-fab:hover .kb-cover-inner,
.kb-fab:focus-visible .kb-cover-inner,
.kb-fab[aria-expanded="true"] .kb-cover-inner {
  box-shadow: 8px 10px 18px rgba(0,0,0,.32), inset 0 0 0 1px rgba(0,0,0,.10);
}

.kb-cover-face,
.kb-cover-inner {
  position: absolute;
  inset: 0;
  border-radius: 2px 4px 4px 2px;
  backface-visibility: hidden;
}
.kb-cover-face {
  background:
    linear-gradient(118deg, var(--kb-board-2) 0 6%, var(--kb-board) 26%, #D0163A 55%, var(--kb-board-2));
  box-shadow: inset -1px 0 0 rgba(0,0,0,.28), 0 4px 12px rgba(0,0,0,.30);
  overflow: hidden;
}
/* Endpaper: what the open board shows the reader. */
.kb-cover-inner {
  transform: rotateY(180deg);
  background:
    repeating-linear-gradient(135deg, rgba(163,46,58,.07) 0 2px, rgba(0,0,0,0) 2px 9px),
    linear-gradient(200deg, #FFFDF8, var(--kb-leaf-2));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.10);
}

/* Foil frame stamped a couple of millimetres in from the edges. Wider on
   the left to clear the hinge groove, so the rule doesn't collide with it. */
.kb-cover-frame {
  position: absolute;
  inset: 6px 5px 6px 10px;
  border: 1px solid rgba(255,255,255,.40);
  border-radius: 1px;
}
/* The hinge groove where the cloth folds over the board. */
.kb-cover-groove {
  position: absolute;
  left: 3px; top: 0; bottom: 0; width: 1px;
  background: rgba(0,0,0,.34);
  box-shadow: 1px 0 0 rgba(255,255,255,.16);
}
/* The byline. Tracking is the first thing to go at this size — the letters
   drift apart into texture — so it stays tight and the size does the work. */
.kb-cover-author {
  position: absolute;
  left: 13px; right: 8px; top: 12px;
  text-align: center;
  font-family: var(--kb-label);
  font-size: 5.2px;
  font-weight: 500;
  letter-spacing: .02em;
  text-transform: uppercase;
  line-height: 1;
  white-space: nowrap;
  color: rgba(255,255,255,.92);
}
.kb-cover-monogram {
  position: absolute;
  left: 10px; right: 5px; top: 50%;
  transform: translateY(-52%);
  text-align: center;
  font-family: var(--font-display, 'Audrey', 'Jost', Georgia, serif);
  font-size: 22px;
  font-weight: 300;
  line-height: 1;
  letter-spacing: .04em;
  color: #fff;
}
/* The full stop, same device as the nav wordmark — but the wordmark's red
   dot would vanish on a red board, so here it is the paper that pops. */
.kb-cover-dot { font-style: normal; color: rgba(255,255,255,.62); }
.kb-cover-rule {
  position: absolute;
  left: 52%; bottom: 15px;
  width: 16px; height: 1px;
  transform: translateX(-50%);
  background: rgba(255,255,255,.55);
}

@media (prefers-reduced-motion: reduce) {
  .kb-fab:hover .kb-page,
  .kb-fab:focus-visible .kb-page,
  .kb-fab[aria-expanded="true"] .kb-page { animation: none; }
  .kb-book, .kb-book-cover, .kb-book-shadow { transition: none; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE PANEL — a page from the site
   ═══════════════════════════════════════════════════════════════════════════ */

.kb-panel {
  position: absolute;
  bottom: 92px;
  right: 0;
  width: 384px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kb-paper);
  /* Square corners and hairline rules: the site sets border-radius 0 on its
     buttons and frames everything in 1px black. */
  border: 1px solid var(--kb-line);
  border-top: 2px solid var(--kb-red);
  border-radius: 0;
  box-shadow: 0 18px 48px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);

  transform: translateY(10px) scale(.99);
  opacity: 0;
  pointer-events: none;
  transition: transform .34s var(--kb-ease), opacity .22s ease;
}
.kb-panel.kb-open {
  transform: translateY(0) scale(1);
  opacity: 1;
  pointer-events: auto;
}

/* ── Header: the title page ─────────────────────────────────────────────── */
.kb-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px 12px 16px;
  background: var(--kb-surf2);
  border-bottom: 1px solid var(--kb-line);
}
.kb-hdr-left  { display: flex; align-items: center; gap: 10px; min-width: 0; }
.kb-hdr-right { display: flex; align-items: center; gap: 2px; }
.kb-hdr-titles { display: grid; gap: 3px; line-height: 1; min-width: 0; }
.kb-hdr-eyebrow {
  font-family: var(--kb-label);
  font-size: 8px;
  letter-spacing: .3em;
  text-transform: uppercase;
  color: var(--kb-muted);
}
.kb-hdr-title {
  font-family: var(--font-display, 'Audrey', 'Jost', Georgia, serif);
  font-size: 1.05rem;
  font-weight: 300;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--kb-ink-hi);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kb-led {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: rgba(0,0,0,.22);
  flex-shrink: 0;
  transition: background .25s, box-shadow .25s;
}
.kb-led-listen {
  background: var(--kb-red);
  box-shadow: 0 0 0 3px var(--kb-tint);
  animation: kb-led-blink .7s ease-in-out infinite;
}
.kb-led-think {
  background: var(--kb-red-mu);
  box-shadow: 0 0 0 3px var(--kb-tint);
  animation: kb-led-blink .45s ease-in-out infinite;
}
.kb-led-speak { background: var(--kb-red); box-shadow: 0 0 0 3px var(--kb-tint); }
@keyframes kb-led-blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

.kb-tts-btn, .kb-close {
  width: 30px; height: 30px;
  border: none;
  border-radius: 0;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s, color .15s;
}
.kb-tts-btn { color: var(--kb-muted); }
.kb-tts-btn:hover { background: rgba(0,0,0,.05); color: var(--kb-ink); }
.kb-tts-btn.kb-tts-on { color: var(--kb-red); }
.kb-tts-btn svg { width: 15px; height: 15px; }
.kb-tts-btn .kb-spk-on  { display: none; }
.kb-tts-btn .kb-spk-off { display: block; }
.kb-tts-btn.kb-tts-on .kb-spk-on  { display: block; }
.kb-tts-btn.kb-tts-on .kb-spk-off { display: none; }

.kb-close { color: var(--kb-muted); }
.kb-close:hover { background: rgba(0,0,0,.05); color: var(--kb-ink-hi); }
.kb-close svg { width: 13px; height: 13px; }

/* ── Ink line ───────────────────────────────────────────────────────────── */
.kb-viz {
  background: var(--kb-surf);
  border-bottom: 1px solid var(--kb-line);
}
.kb-canvas { display: block; width: 100%; height: 62px; }
.kb-viz-status {
  text-align: center;
  font-family: var(--kb-label);
  font-size: 8px;
  letter-spacing: .3em;
  text-transform: uppercase;
  color: var(--kb-muted);
  padding: 0 0 7px;
}

/* ── Messages ───────────────────────────────────────────────────────────── */
.kb-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 8px;
  min-height: 200px;
  max-height: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--kb-paper);
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,.22) transparent;
}
.kb-msgs::-webkit-scrollbar { width: 4px; }
.kb-msgs::-webkit-scrollbar-thumb { background: rgba(0,0,0,.22); }

.kb-row { display: flex; }
.kb-row-user      { justify-content: flex-end; }
.kb-row-assistant { justify-content: flex-start; }

.kb-bub {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: 0;
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  animation: kb-msg-in .22s ease;
}
@keyframes kb-msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* The reader speaks in red; the room answers in ink on paper. */
.kb-bub-user {
  background: var(--kb-red);
  color: #fff;
  box-shadow: 0 2px 10px rgba(227,24,55,.22);
}
/* A red margin rule down the left edge — the annotation in the gutter. */
.kb-bub-assistant {
  background: var(--kb-surf);
  color: var(--kb-ink);
  border: 1px solid var(--kb-line);
  border-left: 2px solid var(--kb-red);
}
.kb-bub-err {
  background: var(--kb-tint);
  border-color: var(--border-red, rgba(227,24,55,.32));
  border-left-color: var(--kb-red-dk);
  color: var(--kb-red-dk);
}

.kb-think-dots {
  display: flex !important;
  align-items: center;
  gap: 5px;
  padding: 13px 16px !important;
}
.kb-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--kb-red);
  display: inline-block;
  animation: kb-dot-bounce 1.1s ease-in-out infinite;
}
.kb-dot:nth-child(2) { animation-delay: .18s; }
.kb-dot:nth-child(3) { animation-delay: .36s; }
@keyframes kb-dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: .55; }
  40%           { transform: translateY(-7px); opacity: 1; }
}

/* ── Suggested-question chips ───────────────────────────────────────────── */
.kb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 16px 12px;
  background: var(--kb-paper);
}
.kb-chips-gone { display: none; }
.kb-chip {
  font-family: var(--kb-label);
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--kb-ink);
  background: transparent;
  border: 1px solid rgba(0,0,0,.28);
  border-radius: 0;
  padding: 6px 10px;
  cursor: pointer;
  transition: color .18s var(--kb-ease), background .18s var(--kb-ease), border-color .18s var(--kb-ease);
}
.kb-chip:hover, .kb-chip:focus-visible {
  color: #fff;
  background: var(--kb-red-mu);
  border-color: var(--kb-red-mu);
}

/* ── Input bar ──────────────────────────────────────────────────────────── */
.kb-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 11px 13px;
  background: var(--kb-surf2);
  border-top: 1px solid var(--kb-line);
}

.kb-mic {
  flex-shrink: 0;
  position: relative;
  width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--kb-paper);
  border: 1px solid rgba(0,0,0,.28);
  color: var(--kb-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .18s, border-color .18s, color .18s;
}
.kb-mic svg { width: 17px; height: 17px; }
.kb-mic:hover { border-color: var(--kb-red); color: var(--kb-red); background: var(--kb-tint); }
.kb-mic-active {
  background: var(--kb-red) !important;
  border-color: var(--kb-red) !important;
  color: #fff !important;
}
.kb-mic-ring {
  position: absolute;
  inset: -7px;
  border-radius: 50%;
  border: 1px solid var(--kb-red);
  pointer-events: none;
  opacity: 0;
}
.kb-mic-active .kb-mic-ring { opacity: 1; animation: kb-mic-pulse 1.1s ease-in-out infinite; }
@keyframes kb-mic-pulse {
  0%   { transform: scale(.9);  opacity: .8; }
  70%  { transform: scale(1.4); opacity: 0; }
  100% { transform: scale(1.4); opacity: 0; }
}

.kb-input {
  flex: 1;
  background: var(--kb-paper);
  border: 1px solid rgba(0,0,0,.28);
  border-radius: 0;
  color: var(--kb-ink);
  font-family: var(--kb-label);
  font-size: 13.5px;
  line-height: 1.5;
  padding: 9px 12px;
  resize: none;
  outline: none;
  min-height: 40px;
  max-height: 112px;
  transition: border-color .18s, box-shadow .18s;
}
.kb-input:focus {
  border-color: var(--kb-red);
  box-shadow: 0 0 0 3px var(--kb-tint);
}
.kb-input::placeholder { color: var(--kb-muted); }
.kb-input:disabled { opacity: .45; }

.kb-send {
  flex-shrink: 0;
  width: 40px; height: 40px;
  border-radius: 0;
  background: var(--kb-red);
  border: 1px solid var(--kb-red);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s, border-color .15s, transform .1s;
}
.kb-send:hover { background: var(--kb-red-mu); border-color: var(--kb-red-mu); }
.kb-send:active { transform: scale(.93); }
.kb-send:disabled {
  background: var(--kb-surf2);
  border-color: var(--kb-line);
  color: var(--kb-muted);
  cursor: not-allowed;
}
.kb-send svg { width: 17px; height: 17px; }

/* ── Bug report ─────────────────────────────────────────────────────────── */
.kb-bug-btn {
  border-radius: 0;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 4px 6px;
  color: var(--kb-muted);
  transition: background .15s, color .15s;
}
.kb-bug-btn:hover { background: rgba(0,0,0,.05); color: var(--kb-ink-hi); }
.kb-bug-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
/* It inches on hover: the body bunches, then the front end reaches forward.
   transform-origin at the tail keeps the squash pulling from behind. */
.kb-bug-btn:hover .kb-bug-icon { animation: kb-inch 1.05s ease-in-out infinite; }
.kb-bug-icon { transform-origin: 10% 70%; }
@keyframes kb-inch {
  0%,100% { transform: translateX(0)     scaleX(1);    }
  35%     { transform: translateX(0)     scaleX(.88);  }
  70%     { transform: translateX(1.2px) scaleX(1.04); }
}
@media (prefers-reduced-motion: reduce) {
  .kb-bug-btn:hover .kb-bug-icon { animation: none; }
}
.kb-bug-lbl {
  font-family: var(--kb-label);
  font-size: 7px;
  letter-spacing: .1em;
  line-height: 1;
  white-space: nowrap;
  text-transform: uppercase;
}

.kb-bug-form {
  background: var(--kb-surf);
  border: 1px solid var(--kb-line);
  border-left: 2px solid var(--kb-ink-hi);
  border-radius: 0;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: kb-msg-in .22s ease;
}
.kb-bug-form-lbl {
  font-family: var(--kb-label);
  font-size: 9px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: var(--kb-muted);
}
.kb-bug-ta {
  background: var(--kb-paper);
  border: 1px solid rgba(0,0,0,.22);
  border-radius: 0;
  color: var(--kb-ink);
  font-family: var(--kb-label);
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 10px;
  resize: none;
  outline: none;
  min-height: 60px;
  width: 100%;
  box-sizing: border-box;
  transition: border-color .15s;
}
.kb-bug-ta:focus { border-color: var(--kb-red); }
.kb-bug-acts { display: flex; gap: 6px; }
.kb-bug-submit {
  flex: 1;
  background: var(--kb-ink-hi);
  border: 1px solid var(--kb-ink-hi);
  border-radius: 0;
  color: #fff;
  font-family: var(--kb-label);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .18em;
  text-transform: uppercase;
  padding: 8px 10px;
  cursor: pointer;
  transition: background .15s, border-color .15s, opacity .15s;
}
.kb-bug-submit:hover { background: var(--kb-red-mu); border-color: var(--kb-red-mu); }
.kb-bug-submit:disabled { opacity: .5; cursor: not-allowed; }
.kb-bug-cancel {
  background: none;
  border: 1px solid rgba(0,0,0,.22);
  border-radius: 0;
  color: var(--kb-muted);
  font-family: var(--kb-label);
  font-size: 10px;
  letter-spacing: .18em;
  text-transform: uppercase;
  padding: 8px 10px;
  cursor: pointer;
  transition: color .15s, border-color .15s;
}
.kb-bug-cancel:hover { color: var(--kb-ink-hi); border-color: var(--kb-ink-hi); }

/* ── Confirmation slip ──────────────────────────────────────────────────── */
.kb-profile-toast {
  font-family: var(--kb-label);
  font-size: 9px;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--kb-red-mu);
  background: var(--kb-tint);
  border: 1px solid var(--border-red, rgba(227,24,55,.32));
  border-radius: 0;
  padding: 7px 14px;
  text-align: center;
  margin: 4px auto;
  max-width: 88%;
  animation: kb-msg-in .22s ease;
}

/* ── Mobile ─────────────────────────────────────────────────────────────── */
@media (max-width: 600px) {
  #kb-chat-widget {
    bottom: 0; right: 0; left: 0; top: auto;
    pointer-events: none;
  }
  .kb-fab {
    position: fixed;
    bottom: 16px; right: 16px;
    pointer-events: auto;
  }
  /* No hover on touch: the book opens as the panel does. */
  .kb-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0; top: auto;
    width: 100%;
    max-width: 100%;
    height: 85vh;
    transform: translateY(100%);
    opacity: 1;
    transition: transform .32s cubic-bezier(.25,.1,.25,1);
    pointer-events: none;
  }
  .kb-panel.kb-open { transform: translateY(0); pointer-events: auto; }
  .kb-msgs { flex: 1; max-height: none; min-height: 0; }
  /* 16px prevents iOS auto-zoom on focus */
  .kb-input { font-size: 16px; }
  .kb-canvas { height: 52px; }
}
  `;
  document.head.appendChild(el);
}
