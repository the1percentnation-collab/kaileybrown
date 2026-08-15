// Kailey Brown course advisor — voice + text chatbot widget.
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
    <!-- Floating Action Button -->
    <button class="kb-fab" id="kb-fab" aria-label="Open course advisor" aria-expanded="false">
      <span class="kb-fab-ring kb-fab-ring-1" aria-hidden="true"></span>
      <span class="kb-fab-ring kb-fab-ring-2" aria-hidden="true"></span>
      <span class="kb-fab-core" aria-hidden="true">
        <svg class="kb-fab-icon" viewBox="0 0 28 20" fill="currentColor">
          <rect x="0"  y="7"  width="4" height="6"  rx="2"/>
          <rect x="6"  y="4"  width="4" height="12" rx="2"/>
          <rect x="12" y="0"  width="4" height="20" rx="2"/>
          <rect x="18" y="4"  width="4" height="12" rx="2"/>
          <rect x="24" y="7"  width="4" height="6"  rx="2"/>
        </svg>
      </span>
    </button>

    <!-- Chat Panel -->
    <div class="kb-panel" id="kb-panel" role="dialog" aria-modal="true" aria-label="Kailey Brown assistant">
      <!-- Corner targeting marks -->
      <i class="kb-crn kb-crn-tl" aria-hidden="true"></i>
      <i class="kb-crn kb-crn-tr" aria-hidden="true"></i>
      <i class="kb-crn kb-crn-bl" aria-hidden="true"></i>
      <i class="kb-crn kb-crn-br" aria-hidden="true"></i>

      <!-- Header -->
      <div class="kb-hdr">
        <div class="kb-hdr-left">
          <span class="kb-led" id="kb-led" aria-hidden="true"></span>
          <span class="kb-hdr-title">Assistant</span>
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
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" clip-rule="evenodd"
                d="M12 2C7.03 2 3 5.8 3 10.2c0 3.5 2 6.6 5 8.1V22h8v-3.7c3-1.5 5-4.6 5-8.1C21 5.8 16.97 2 12 2z
                   M4.5 10a2.5 2 0 1 0 5 0 2.5 2 0 0 0-5 0z
                   M14.5 10a2.5 2 0 1 0 5 0 2.5 2 0 0 0-5 0z
                   M10 20h1.5v2H10z M12.5 20h1.5v2h-1.5z"/>
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

      <!-- Wave visualizer -->
      <div class="kb-viz" aria-hidden="true">
        <canvas id="kb-canvas" class="kb-canvas"></canvas>
        <div class="kb-viz-status" id="kb-viz-status">READY</div>
      </div>

      <!-- Messages -->
      <div class="kb-msgs" id="kb-msgs" role="log" aria-live="polite" aria-label="Conversation"></div>

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
          placeholder="Type or speak your question…"
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
      setTimeout(() => addMsg('assistant', 'Hi. Ask me anything about our courses, your progress, or what you\'d like to learn next. You can type or tap the mic to speak.'), 350);
    }
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
    fillGrad.addColorStop(0, 'rgba(230,3,6,0.22)');
    fillGrad.addColorStop(1, 'rgba(230,3,6,0)');
    ctx.save();
    ctx.beginPath();
    wave(ctx, W, H, a, cfg.speed, frame, 0);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.restore();

    // Wave layers (primary, secondary, highlight)
    strokeWave(ctx, W, H, a,        cfg.speed, frame, 0,              '#C8102E',           1.00, 2.2);
    strokeWave(ctx, W, H, a * 0.60, cfg.speed, frame, Math.PI / 2.2, 'rgba(255,80,80,.5)', 1.00, 1.4);
    strokeWave(ctx, W, H, a * 0.28, cfg.speed, frame, Math.PI,       'rgba(255,255,255,.14)', 1.00, 1.0);

    // Center glow line
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(frame * 0.05);
    ctx.strokeStyle = '#C8102E';
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
/* ── Widget root ─────────────────────────────────────────────── */
#kb-chat-widget {
  position: fixed;
  bottom: 28px;
  right: 28px;
  z-index: 9999;
  font-family: 'Jost', sans-serif;
}

/* ── FAB ─────────────────────────────────────────────────────── */
.kb-fab {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: #0d0d0d;
  box-shadow:
    0 0 0 1.5px rgba(230,3,6,.55),
    0 0 18px rgba(230,3,6,.35),
    0 6px 24px rgba(0,0,0,.7);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: box-shadow .2s ease, transform .18s ease;
}
.kb-fab:hover {
  transform: scale(1.07);
  box-shadow:
    0 0 0 1.5px rgba(230,3,6,.8),
    0 0 28px rgba(230,3,6,.55),
    0 8px 32px rgba(0,0,0,.75);
}
.kb-fab:active { transform: scale(.96); }

/* Pulse rings */
.kb-fab-ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(230,3,6,.45);
  pointer-events: none;
  animation: kb-ring 2.8s cubic-bezier(.215,.61,.355,1) infinite;
}
.kb-fab-ring-1 { inset: -10px; animation-delay: 0s; }
.kb-fab-ring-2 { inset: -20px; animation-delay: .9s; }
@keyframes kb-ring {
  0%   { transform: scale(.88); opacity: .8; }
  70%  { transform: scale(1.2); opacity: 0; }
  100% { transform: scale(1.2); opacity: 0; }
}

/* Waveform bars in FAB icon */
.kb-fab-core { color: #C8102E; display: flex; }
.kb-fab-icon { width: 28px; height: 20px; }
.kb-fab-icon rect {
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: kb-fab-bar 1.7s ease-in-out infinite;
}
.kb-fab-icon rect:nth-child(1) { animation-delay: 0s; }
.kb-fab-icon rect:nth-child(2) { animation-delay: .12s; }
.kb-fab-icon rect:nth-child(3) { animation-delay: .24s; }
.kb-fab-icon rect:nth-child(4) { animation-delay: .12s; }
.kb-fab-icon rect:nth-child(5) { animation-delay: 0s; }
@keyframes kb-fab-bar {
  0%, 100% { transform: scaleY(1); }
  50%       { transform: scaleY(.35); }
}

/* ── Panel ───────────────────────────────────────────────────── */
.kb-panel {
  position: absolute;
  bottom: 72px;
  right: 0;
  width: 380px;
  max-width: calc(100vw - 40px);
  border-radius: 18px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* Subtle grid overlay background */
  background:
    linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px),
    #090909;
  background-size: 22px 22px, 22px 22px, auto;
  border: 1px solid rgba(230,3,6,.38);
  box-shadow:
    0 0 0 1px rgba(230,3,6,.10),
    0 0 40px rgba(230,3,6,.10),
    0 24px 64px rgba(0,0,0,.85),
    inset 0 1px 0 rgba(255,255,255,.06);
  /* Scanline overlay */
  --scan: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 3px,
    rgba(0,0,0,.06) 3px,
    rgba(0,0,0,.06) 4px
  );

  /* Closed state */
  transform: scale(.93) translateY(10px);
  opacity: 0;
  pointer-events: none;
  transition:
    transform .32s cubic-bezier(.34,1.56,.64,1),
    opacity   .22s ease;
}
.kb-panel::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--scan);
  pointer-events: none;
  border-radius: inherit;
  z-index: 20;
}
.kb-panel.kb-open {
  transform: scale(1) translateY(0);
  opacity: 1;
  pointer-events: auto;
}

/* Corner targeting marks */
.kb-crn {
  position: absolute;
  width: 14px;
  height: 14px;
  pointer-events: none;
  z-index: 2;
}
.kb-crn-tl { top:8px;    left:8px;  border-top:1.5px solid rgba(230,3,6,.7); border-left:1.5px solid rgba(230,3,6,.7); }
.kb-crn-tr { top:8px;    right:8px; border-top:1.5px solid rgba(230,3,6,.7); border-right:1.5px solid rgba(230,3,6,.7); }
.kb-crn-bl { bottom:8px; left:8px;  border-bottom:1.5px solid rgba(230,3,6,.7); border-left:1.5px solid rgba(230,3,6,.7); }
.kb-crn-br { bottom:8px; right:8px; border-bottom:1.5px solid rgba(230,3,6,.7); border-right:1.5px solid rgba(230,3,6,.7); }

/* ── Header ──────────────────────────────────────────────────── */
.kb-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px;
  background: rgba(5,5,5,.8);
  border-bottom: 1px solid rgba(230,3,6,.18);
  position: relative;
  z-index: 1;
}
.kb-hdr-left  { display: flex; align-items: center; gap: 9px; }
.kb-hdr-right { display: flex; align-items: center; gap: 4px; }

.kb-led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #333;
  flex-shrink: 0;
  transition: background .25s, box-shadow .25s;
}
.kb-led-listen {
  background: #C8102E;
  box-shadow: 0 0 8px #C8102E;
  animation: kb-led-blink .7s ease-in-out infinite;
}
.kb-led-think {
  background: #ff8800;
  box-shadow: 0 0 7px #ff8800;
  animation: kb-led-blink .45s ease-in-out infinite;
}
.kb-led-speak {
  background: #C8102E;
  box-shadow: 0 0 10px #C8102E;
}
@keyframes kb-led-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: .25; }
}

.kb-hdr-title {
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  letter-spacing: .18em;
  color: #d0d0d8;
  font-weight: 700;
}
.kb-hdr-badge {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  letter-spacing: .12em;
  color: #C8102E;
  border: 1px solid rgba(230,3,6,.45);
  border-radius: 4px;
  padding: 1px 6px;
}

.kb-tts-btn, .kb-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s, color .15s;
}
.kb-tts-btn { color: #444; }
.kb-tts-btn:hover { background: rgba(255,255,255,.05); color: #888; }
.kb-tts-btn.kb-tts-on  { color: #C8102E; }
.kb-tts-btn svg { width: 15px; height: 15px; }

/* Show/hide speaker icons based on state */
.kb-tts-btn .kb-spk-on  { display: none; }
.kb-tts-btn .kb-spk-off { display: block; }
.kb-tts-btn.kb-tts-on .kb-spk-on  { display: block; }
.kb-tts-btn.kb-tts-on .kb-spk-off { display: none; }

.kb-close { color: #555; }
.kb-close:hover { background: rgba(255,255,255,.06); color: #ccc; }
.kb-close svg { width: 13px; height: 13px; }

/* ── Wave visualizer ─────────────────────────────────────────── */
.kb-viz {
  background: #050505;
  border-bottom: 1px solid rgba(255,255,255,.05);
  position: relative;
}
.kb-canvas {
  display: block;
  width: 100%;
  height: 80px;
}
.kb-viz-status {
  text-align: center;
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  letter-spacing: .28em;
  color: rgba(230,3,6,.75);
  padding: 3px 0 7px;
}

/* ── Messages ────────────────────────────────────────────────── */
.kb-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 14px 14px 6px;
  min-height: 200px;
  max-height: 280px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  scrollbar-width: thin;
  scrollbar-color: #2a2a2a transparent;
}
.kb-msgs::-webkit-scrollbar { width: 4px; }
.kb-msgs::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

.kb-row { display: flex; }
.kb-row-user      { justify-content: flex-end; }
.kb-row-assistant { justify-content: flex-start; }

.kb-bub {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  animation: kb-msg-in .22s ease;
}
@keyframes kb-msg-in {
  from { opacity: 0; transform: translateY(6px) scale(.97); }
  to   { opacity: 1; transform: translateY(0)   scale(1); }
}

.kb-bub-user {
  background: linear-gradient(135deg, #c20204, #C8102E);
  color: #fff;
  border-bottom-right-radius: 4px;
  box-shadow: 0 3px 14px rgba(230,3,6,.35);
}
.kb-bub-assistant {
  background: rgba(14,14,14,.95);
  color: #e2e2e8;
  border: 1px solid rgba(230,3,6,.22);
  border-bottom-left-radius: 4px;
  box-shadow: 0 2px 10px rgba(0,0,0,.45);
}
.kb-bub-err {
  background: rgba(30,10,10,.95);
  border-color: rgba(200,50,50,.5);
  color: #f08888;
}

/* Thinking dots */
.kb-think-dots {
  display: flex !important;
  align-items: center;
  gap: 5px;
  padding: 12px 16px !important;
}
.kb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #C8102E;
  display: inline-block;
  animation: kb-dot-bounce 1.1s ease-in-out infinite;
}
.kb-dot:nth-child(2) { animation-delay: .18s; }
.kb-dot:nth-child(3) { animation-delay: .36s; }
@keyframes kb-dot-bounce {
  0%, 80%, 100% { transform: translateY(0) scale(1); opacity: .7; }
  40%            { transform: translateY(-8px) scale(1.15); opacity: 1; }
}

/* ── Input bar ───────────────────────────────────────────────── */
.kb-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 11px 13px;
  background: rgba(5,5,5,.85);
  border-top: 1px solid rgba(230,3,6,.15);
  position: relative;
  z-index: 1;
}

/* Mic button */
.kb-mic {
  flex-shrink: 0;
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(230,3,6,.07);
  border: 1px solid rgba(230,3,6,.28);
  color: #666;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .18s, border-color .18s, color .18s, box-shadow .18s;
}
.kb-mic svg { width: 17px; height: 17px; }
.kb-mic:hover {
  background: rgba(230,3,6,.14);
  border-color: rgba(230,3,6,.55);
  color: #C8102E;
}
.kb-mic-active {
  background: rgba(230,3,6,.22) !important;
  border-color: #C8102E !important;
  color: #C8102E !important;
  box-shadow: 0 0 14px rgba(230,3,6,.45) !important;
}
.kb-mic-ring {
  position: absolute;
  inset: -7px;
  border-radius: 50%;
  border: 1px solid rgba(230,3,6,.5);
  pointer-events: none;
  opacity: 0;
}
.kb-mic-active .kb-mic-ring {
  opacity: 1;
  animation: kb-mic-pulse 1.1s ease-in-out infinite;
}
@keyframes kb-mic-pulse {
  0%   { transform: scale(.9);  opacity: .9; }
  70%  { transform: scale(1.4); opacity: 0; }
  100% { transform: scale(1.4); opacity: 0; }
}

/* Textarea */
.kb-input {
  flex: 1;
  background: rgba(10,10,10,.95);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 11px;
  color: #e8e8f0;
  font-family: 'Jost', sans-serif;
  font-size: 13.5px;
  line-height: 1.5;
  padding: 9px 13px;
  resize: none;
  outline: none;
  min-height: 40px;
  max-height: 112px;
  transition: border-color .18s, box-shadow .18s;
}
.kb-input:focus {
  border-color: rgba(230,3,6,.6);
  box-shadow: 0 0 0 3px rgba(230,3,6,.12);
}
.kb-input::placeholder { color: #444; }
.kb-input:disabled { opacity: .45; }

/* Send button */
.kb-send {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: #C8102E;
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s, transform .1s, box-shadow .18s;
  box-shadow: 0 3px 12px rgba(230,3,6,.4);
}
.kb-send:hover {
  background: #c20205;
  box-shadow: 0 4px 18px rgba(230,3,6,.6);
}
.kb-send:active { transform: scale(.9); }
.kb-send:disabled { background: #2a2a2a; box-shadow: none; cursor: not-allowed; }
.kb-send svg { width: 17px; height: 17px; }

/* ── Bug report button ───────────────────────────────────────── */
.kb-bug-btn {
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 4px 6px;
  color: #888;
  transition: background .15s, color .15s;
}
.kb-bug-btn:hover { background: rgba(255,255,255,.05); color: #ff9500; }
.kb-bug-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
.kb-bug-lbl {
  font-family: 'Jost', sans-serif;
  font-size: 7px;
  letter-spacing: .04em;
  line-height: 1;
  white-space: nowrap;
  text-transform: lowercase;
}

/* ── Bug report inline form ──────────────────────────────────── */
.kb-bug-form {
  background: rgba(20,12,0,.95);
  border: 1px solid rgba(255,149,0,.28);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: kb-msg-in .22s ease;
}
.kb-bug-form-lbl {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #ff9500;
}
.kb-bug-ta {
  background: rgba(10,8,0,.9);
  border: 1px solid rgba(255,149,0,.18);
  border-radius: 8px;
  color: #e8e8f0;
  font-family: 'Jost', sans-serif;
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
.kb-bug-ta:focus { border-color: rgba(255,149,0,.45); }
.kb-bug-acts { display: flex; gap: 6px; }
.kb-bug-submit {
  flex: 1;
  background: #ff9500;
  border: none;
  border-radius: 8px;
  color: #000;
  font-family: 'Jost', sans-serif;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 10px;
  cursor: pointer;
  transition: background .15s, opacity .15s;
}
.kb-bug-submit:hover { background: #ffaa22; }
.kb-bug-submit:disabled { opacity: .5; cursor: not-allowed; }
.kb-bug-cancel {
  background: none;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px;
  color: #666;
  font-family: 'Jost', sans-serif;
  font-size: 12px;
  padding: 7px 10px;
  cursor: pointer;
  transition: color .15s, border-color .15s;
}
.kb-bug-cancel:hover { color: #aaa; border-color: rgba(255,255,255,.22); }


/* ── Profile update toast ────────────────────────────────────── */
.kb-profile-toast {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #4ade80;
  border: 1px solid rgba(74,222,128,.25);
  border-radius: 8px;
  padding: 6px 14px;
  text-align: center;
  margin: 4px auto;
  max-width: 85%;
  animation: kb-msg-in .22s ease;
}

/* ── Mobile ──────────────────────────────────────────────────── */
@media (max-width: 600px) {
  /* Widget spans full width at the bottom */
  #kb-chat-widget {
    bottom: 0; right: 0; left: 0; top: auto;
    pointer-events: none;
  }
  /* FAB stays pinned to bottom-right */
  .kb-fab {
    position: fixed;
    bottom: 18px; right: 18px;
    pointer-events: auto;
  }
  /* Bottom sheet: ~85vh, rounded top corners, slides up */
  .kb-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0; top: auto;
    width: 100%;
    max-width: 100%;
    height: 85vh;
    border-radius: 20px 20px 0 0;
    transform: translateY(100%);
    opacity: 1;
    transition: transform .32s cubic-bezier(.25,.1,.25,1);
    pointer-events: none;
  }
  .kb-panel.kb-open {
    transform: translateY(0);
    pointer-events: auto;
  }
  /* Messages fill remaining height */
  .kb-msgs { flex: 1; max-height: none; min-height: 0; }
  /* 16px prevents iOS auto-zoom on focus */
  .kb-input { font-size: 16px; }
  /* Shorter wave on mobile to preserve message space */
  .kb-canvas { height: 60px; }
}
  `;
  document.head.appendChild(el);
}
