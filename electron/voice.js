// Voice commands — the speech engine (main process).
//
// Speech is turned into text by Whisper (whisper.cpp, MIT), running on
// this PC, offline and free. Main does three things:
//
//   1. Download, the first time the owner asks: the whisper.cpp program
//      for Windows (~9 MB, from its GitHub releases) and one Whisper model
//      (from Hugging Face). Neither is part of the installer or updates.
//   2. Start whisper-server on 127.0.0.1 only when someone starts speaking,
//      and stop it again after a few idle minutes, so nothing runs or
//      holds memory while voice isn't used.
//   3. Take the recorded WAV from the renderer and return the text.
//
// Files live in <userData>/voice-engine and <userData>/voice-models.

const { app, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { readZipEntries } = require('./voiceArchive');

// Pinned whisper.cpp build. CPU only: it picks the fastest code path the
// processor supports (AVX2, AVX…) on its own.
const ENGINE = {
  tag: 'b5454',
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sizeMB: 9,
};

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const MODELS = {
  small: { file: 'ggml-small-q5_1.bin', url: `${HF}/ggml-small-q5_1.bin`, label: 'Whisper Small', sizeMB: 182 },
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', url: `${HF}/ggml-large-v3-turbo-q5_0.bin`, label: 'Whisper Large Turbo', sizeMB: 547 },
};

const IDLE_STOP_MS = 30 * 60_000;
const START_TIMEOUT_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

const engineDir = () => path.join(app.getPath('userData'), 'voice-engine', ENGINE.tag);
const modelsDir = () => path.join(app.getPath('userData'), 'voice-models');
const modelPath = (m) => path.join(modelsDir(), m.file);

function findFile(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
  }
  return null;
}
const serverExe = () => findFile(engineDir(), 'whisper-server.exe');

// The first voice build used Vosk models; they are no longer read.
function dropVoskModels() {
  try {
    for (const f of fs.readdirSync(modelsDir())) {
      if (f.startsWith('vosk-model-')) fs.rmSync(path.join(modelsDir(), f), { force: true, recursive: true });
    }
  } catch { /* no folder yet */ }
}

function status(key) {
  const m = MODELS[key];
  if (!m) return { ok: false, error: 'Unknown speech model' };
  dropVoskModels();
  let bytes = 0;
  try { bytes = fs.statSync(modelPath(m)).size; } catch { /* not yet */ }
  const engine = !!serverExe();
  const model = bytes > 1048576;
  return { ok: true, model: key, label: m.label, sizeMB: m.sizeMB + (engine ? 0 : ENGINE.sizeMB), engine, installed: engine && model, bytes };
}

// ── download ────────────────────────────────────────────────────────
// Streams to "<file>.part" and renames at the end, so a cut connection
// never leaves a file that looks complete.
async function fetchTo(url, dest, onBytes) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      got += value.length;
      onBytes(got, total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  if (total && got !== total) { fs.rmSync(tmp, { force: true }); throw new Error('Download was cut off'); }
  fs.renameSync(tmp, dest);
}

const inFlight = new Map();

async function download(key, onProgress) {
  const m = MODELS[key];
  if (!m) throw new Error('Unknown speech model');
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    const engineBytes = serverExe() ? 0 : ENGINE.sizeMB * 1048576;
    const modelBytes = fs.existsSync(modelPath(m)) ? 0 : m.sizeMB * 1048576;
    const total = engineBytes + modelBytes || 1;
    let lastSent = 0;
    const report = (received) => {
      if (received - lastSent < 512 * 1024 && received < total) return;
      lastSent = received;
      onProgress({ model: key, received, total });
    };
    if (engineBytes) {
      const dir = engineDir();
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, 'whisper-bin-x64.zip');
      await fetchTo(ENGINE.url, zip, (got) => report(Math.min(got, engineBytes)));
      for (const { name, data } of readZipEntries(fs.readFileSync(zip))) {
        const dest = path.join(dir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
      }
      fs.rmSync(zip, { force: true });
      if (!serverExe()) throw new Error('The speech engine download did not contain whisper-server.exe');
    }
    if (modelBytes) {
      fs.mkdirSync(modelsDir(), { recursive: true });
      await fetchTo(m.url, modelPath(m), (got) => report(engineBytes + Math.min(got, modelBytes)));
    }
    return status(key);
  })();
  inFlight.set(key, job);
  try { return await job; } finally { inFlight.delete(key); }
}

function remove(key) {
  const m = MODELS[key];
  if (!m) return { ok: false, error: 'Unknown speech model' };
  if (server?.key === key) stopServer();
  try { fs.rmSync(modelPath(m), { force: true }); } catch { /* already gone */ }
  return status(key);
}

// ── whisper-server ──────────────────────────────────────────────────
let server = null;     // { key, lang, port, proc, ready: Promise, log: string[] }
let idleTimer = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function stopServer() {
  clearTimeout(idleTimer);
  const s = server;
  server = null;
  if (s?.proc && s.proc.exitCode == null) { try { s.proc.kill(); } catch { /* already gone */ } }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopServer, IDLE_STOP_MS);
}

async function waitReady(s) {
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until) {
    if (s.failed) throw new Error(`The speech engine could not start: ${s.failed.message}`);
    if (s.proc.exitCode != null) throw new Error(`The speech engine stopped: ${s.log.slice(-3).join(' ').trim() || `exit ${s.proc.exitCode}`}`);
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/health`);
      // 503 while the model loads; older builds have no /health at all.
      if (r.ok || r.status === 404) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('The speech engine took too long to start');
}

async function ensureServer(key, lang) {
  const m = MODELS[key];
  if (!m) throw new Error('Unknown speech model');
  if (server && server.key === key && server.lang === lang && server.proc.exitCode == null && !server.failed) {
    touch();
    return server.ready.then(() => server);
  }
  const exe = serverExe();
  if (!exe || !fs.existsSync(modelPath(m))) {
    const err = new Error('The speech model is not downloaded yet');
    err.code = 'model-missing';
    throw err;
  }
  stopServer();
  const port = await freePort();
  const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2) || 2));
  const proc = spawn(exe, [
    '-m', modelPath(m), '--host', '127.0.0.1', '--port', String(port),
    '-t', String(threads), '-l', lang, '-nt', '-bo', '1',
  ], { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { key, lang, port, proc, log: [] };
  const keep = (d) => { s.log.push(String(d)); if (s.log.length > 40) s.log.shift(); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  proc.on('exit', () => { if (server === s) server = null; });
  // e.g. antivirus blocked the program; without a handler this would take the app down.
  proc.on('error', (e) => { s.failed = e; if (server === s) server = null; });
  s.ready = waitReady(s);
  server = s;
  touch();
  try { await s.ready; } catch (e) { stopServer(); throw e; }
  return s;
}

// Whisper writes these for silence or noise instead of words.
const NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;

// The last few recordings and what Whisper made of them, on this PC only,
// so a wrong or slow result can be looked into. Older ones are deleted.
const debugDir = () => path.join(app.getPath('userData'), 'voice-debug');
const DEBUG_KEEP = 20;
function keepDebug(wav, info) {
  try {
    const dir = debugDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.wav`), Buffer.from(wav));
    fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ at: stamp, ...info })}\n`);
    const wavs = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
    for (const f of wavs.slice(0, Math.max(0, wavs.length - DEBUG_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* never let logging break a command */ }
}

async function transcribe({ model, lang, wav, prompt, seconds = 30, peak }) {
  const t0 = Date.now();
  const s = await ensureServer(model, lang);
  const tReady = Date.now();
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // No retries at higher temperatures: unclear audio would take several
  // times as long and still come out wrong.
  form.append('temperature_inc', '0');
  form.append('language', lang);
  form.append('no_timestamps', 'true');
  if (prompt) form.append('prompt', prompt);
  // Whisper normally works through a 30-second window however short the
  // clip; a smaller one for a few seconds of speech is several times
  // faster. 50 steps per second, with room to spare.
  form.append('audio_ctx', String(Math.min(1500, Math.max(384, Math.ceil(seconds * 50) + 100))));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/inference`, { method: 'POST', body: form, signal: ctl.signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) throw new Error(body.error || `Speech engine error (HTTP ${r.status})`);
    const text = String(body.text || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    keepDebug(wav, { model, lang, seconds, peak, raw: body.text, text, startMs: tReady - t0, whisperMs: Date.now() - tReady });
    return text;
  } finally {
    clearTimeout(timer);
    touch();
  }
}

function init({ window }) {
  ipcMain.handle('voice:model-status', (_e, key) => status(key));
  ipcMain.handle('voice:model-remove', (_e, key) => remove(key));
  ipcMain.handle('voice:model-download', async (_e, key) => {
    try {
      return await download(key, (p) => {
        const w = window();
        if (w && !w.isDestroyed()) w.webContents.send('voice:model-progress', p);
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // Called the moment someone starts speaking, so the model is loaded by
  // the time they let go.
  ipcMain.handle('voice:warm', async (_e, { model, lang }) => {
    try { await ensureServer(model, lang); return { ok: true }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  ipcMain.handle('voice:transcribe', async (_e, req) => {
    try { return { ok: true, text: await transcribe(req) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  app.on('will-quit', stopServer);
}

module.exports = { init, MODELS };
