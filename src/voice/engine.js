/*
 * Speech engine — the renderer half. Records the microphone while the
 * hotkey / mic button is held, then hands one short WAV to Whisper in the
 * main process (electron/voice.js), which runs offline on this PC.
 *
 *   hold()     opens the mic (first time) and starts recording; also asks
 *              main to start Whisper so it is ready when the operator
 *              lets go.
 *   release()  stops recording and resolves with what was said.
 *
 * Nothing is recorded or sent anywhere outside this computer. Whisper
 * only works between the two calls; when idle it costs nothing.
 */

const MIC_IDLE_CLOSE_MS = 60_000;   // let go of the mic (and its tray icon) after a minute unused
const PRE_ROLL_S = 0.35;            // keep the start of a word said just before the key went down
const RATE = 16000;                 // what Whisper expects
const MIN_SPEECH_S = 0.3;

// The voice setting 'en-in' is plain English to Whisper.
const whisperLang = (lang) => (lang === 'en-in' ? 'en' : 'hi');

// A few example commands steer Whisper towards ZEHEN's words and the way
// they are written: Devanagari for Hindi, digits for numbers.
const PROMPTS = {
  hi: 'ज़ेहन, अली का सेल्स बिल बनाओ। अली का लेजर दिखाओ। क्वांटिटी 10 करो। फ्रॉक 20x20 ऐड करो। बारकोड 8901234567। बिल 1452 खोलो।',
  en: 'Zehen, create sales bill for Ali. Show Ali ledger. Make it 10. Add frock 20x20. Add barcode 8901234567. Open bill 1452. Open stock report.',
};

export const voiceAvailable = () =>
  typeof window !== 'undefined' && !!window.electronAPI?.voice?.transcribe && !!navigator.mediaDevices?.getUserMedia;

function toWav(chunks, fromRate) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  // Average down to 16 kHz (mics run at 44.1 / 48 kHz).
  const ratio = fromRate / RATE;
  const len = Math.floor(all.length / ratio);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * 2, true);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const x = Math.max(-1, Math.min(1, s / (b - a)));
    peak = Math.max(peak, Math.abs(x));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return { wav: new Uint8Array(buf), seconds: len / RATE, peak };
}

export class VoiceEngine {
  constructor() {
    this.model = null;           // 'small' | 'turbo' once load() succeeded
    this.lang = null;
    this.ctx = null;
    this.stream = null;
    this.recording = false;
    this.chunks = [];
    this.ring = [];              // last PRE_ROLL_S of audio while not recording
    this.onLevel = null;         // 0…1 while recording, for the listening bars
    this.idleTimer = null;
  }

  async load(lang, model) {
    const st = await window.electronAPI.voice.modelStatus(model);
    if (!st?.ok || !st.installed) {
      const err = new Error('The speech model is not downloaded yet');
      err.code = 'model-missing';
      throw err;
    }
    this.model = model;
    this.lang = whisperLang(lang);
  }

  warm() {
    if (!this.model) return Promise.resolve({ ok: false });
    return window.electronAPI.voice.warm({ model: this.model, lang: this.lang });
  }

  async openMic() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    const keep = Math.ceil((PRE_ROLL_S * this.ctx.sampleRate) / 4096);
    node.onaudioprocess = (e) => {
      const block = new Float32Array(e.inputBuffer.getChannelData(0));
      if (this.recording) {
        this.chunks.push(block);
        if (this.onLevel) {
          let s = 0;
          for (let i = 0; i < block.length; i += 8) s += block[i] * block[i];
          this.onLevel(Math.min(1, Math.sqrt(s / (block.length / 8)) * 6));
        }
      } else {
        this.ring.push(block);
        if (this.ring.length > keep) this.ring.shift();
      }
    };
    source.connect(node);
    node.connect(this.ctx.destination);
  }

  closeMic() {
    clearTimeout(this.idleTimer);
    this.recording = false;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.stream = null;
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.ring = [];
  }

  async hold() {
    clearTimeout(this.idleTimer);
    this.warm().catch(() => {});
    await this.openMic();
    await this.ctx.resume();
    this.chunks = [...this.ring];
    this.ring = [];
    this.recording = true;
  }

  // Resolves with the words heard ('' for silence). Throws when Whisper
  // could not run, with the reason in the message.
  async release() {
    if (!this.recording) return '';
    this.recording = false;
    const rate = this.ctx.sampleRate;
    const chunks = this.chunks;
    this.chunks = [];
    this.idleTimer = setTimeout(() => this.closeMic(), MIC_IDLE_CLOSE_MS);
    const { wav, seconds, peak } = toWav(chunks, rate);
    // A tap, or nothing but room noise: don't make Whisper guess.
    if (seconds < MIN_SPEECH_S + PRE_ROLL_S || peak < 0.02) return '';
    const res = await window.electronAPI.voice.transcribe({
      model: this.model, lang: this.lang, wav, prompt: PROMPTS[this.lang],
    });
    if (!res?.ok) {
      const err = new Error(res?.error || 'The speech engine did not answer');
      err.code = res?.code;
      throw err;
    }
    // Whisper sometimes repeats the hint back for unclear audio.
    if (res.text.length > 40 && PROMPTS[this.lang].includes(res.text)) return '';
    return res.text || '';
  }

  unload() {
    this.closeMic();
    this.model = null;
    this.lang = null;
  }
}
