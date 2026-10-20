/*
 * Speech engine — Vosk compiled to WebAssembly, running in its own Web
 * Worker, fully offline. Nothing here loads until voice is turned on:
 * the ~5 MB engine is a lazy import() and the model comes from
 * electron/voice.js at zehen-voice://models/….
 *
 * Two ways to listen:
 *   push-to-talk  hold(): mic audio reaches the engine only while the
 *                 hotkey / mic button is held; release() resolves with
 *                 what was said. Idle cost is zero.
 *   wake word     listenAlways(onUtterance): every finished sentence is
 *                 handed back; the caller keeps only ones that start
 *                 with "Zehen".
 */

const MIC_IDLE_CLOSE_MS = 60_000;   // let go of the mic (and its tray icon) after a minute unused
const FINAL_WAIT_MS = 1500;

export const voiceAvailable = () =>
  typeof window !== 'undefined' && !!window.electronAPI?.voice && !!navigator.mediaDevices?.getUserMedia;

export class VoiceEngine {
  constructor() {
    this.model = null;
    this.lang = null;
    this.recognizer = null;
    this.ctx = null;
    this.stream = null;
    this.feeding = false;
    this.always = null;          // onUtterance callback in wake-word mode
    this.heard = [];             // finished pieces during one push-to-talk hold
    this.partial = '';
    this.onPartial = null;
    this.finalWaiter = null;
    this.idleTimer = null;
  }

  async load(lang) {
    if (this.model && this.lang === lang) return;
    this.unload();
    const st = await window.electronAPI.voice.modelStatus(lang);
    if (!st?.ok || !st.installed) {
      const err = new Error('The voice model for this language is not downloaded yet');
      err.code = 'model-missing';
      throw err;
    }
    const mod = await import('vosk-browser');
    const Vosk = mod.createModel ? mod : mod.default;   // UMD build: named or default export
    this.model = await Vosk.createModel(st.url);
    this.model.setLogLevel(-2);
    this.lang = lang;
  }

  async openMic() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    const rec = new this.model.KaldiRecognizer(this.ctx.sampleRate);
    rec.on('partialresult', (m) => {
      this.partial = m.result?.partial || '';
      this.onPartial?.(this.always ? this.partial : [...this.heard, this.partial].join(' ').trim());
    });
    rec.on('result', (m) => {
      const text = (m.result?.text || '').trim();
      this.partial = '';
      if (this.always) { if (text) this.always(text); return; }
      if (text) this.heard.push(text);
      if (this.finalWaiter) { const done = this.finalWaiter; this.finalWaiter = null; done(); }
    });
    this.recognizer = rec;
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is old but runs everywhere Electron does, and the
    // engine's worker does the real work, so the main thread only copies
    // 4096-sample blocks.
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!this.feeding) return;
      try { this.recognizer.acceptWaveform(e.inputBuffer); } catch { /* engine busy or gone */ }
    };
    source.connect(node);
    node.connect(this.ctx.destination);
  }

  closeMic() {
    clearTimeout(this.idleTimer);
    this.feeding = false;
    try { this.recognizer?.remove(); } catch { /* already removed */ }
    this.recognizer = null;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.stream = null;
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }

  // ── push-to-talk ──────────────────────────────────────────────────
  async hold() {
    clearTimeout(this.idleTimer);
    await this.openMic();
    await this.ctx.resume();
    this.heard = [];
    this.partial = '';
    this.feeding = true;
  }

  async release() {
    if (!this.feeding) return '';
    this.feeding = false;
    const done = new Promise((resolve) => {
      this.finalWaiter = resolve;
      setTimeout(resolve, FINAL_WAIT_MS);
    });
    try { this.recognizer.retrieveFinalResult(); } catch { /* fall back to the partial */ }
    await done;
    this.finalWaiter = null;
    const text = (this.heard.join(' ') || this.partial).trim();
    this.heard = [];
    this.partial = '';
    this.ctx?.suspend();
    this.idleTimer = setTimeout(() => { if (!this.always) this.closeMic(); }, MIC_IDLE_CLOSE_MS);
    return text;
  }

  // ── wake word ─────────────────────────────────────────────────────
  async listenAlways(onUtterance) {
    this.always = onUtterance;
    await this.openMic();
    await this.ctx.resume();
    this.feeding = true;
  }

  // Push-to-talk while the wake word is on: keep the microphone open,
  // just stop treating sentences as wake-word candidates.
  pauseAlways() { this.always = null; }

  stopAlways() {
    if (!this.always) return;
    this.always = null;
    this.closeMic();
  }

  unload() {
    this.always = null;
    this.closeMic();
    try { this.model?.terminate(); } catch { /* ignore */ }
    this.model = null;
    this.lang = null;
  }
}
