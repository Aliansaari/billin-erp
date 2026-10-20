// Voice commands — speech model download + serving (main process).
//
// The speech engine itself (Vosk, compiled to WebAssembly) runs in a Web
// Worker in the renderer; see src/voice/engine.js. Main only does what a
// renderer can't:
//
//   1. Download the free offline model from alphacephei.com the first
//      time the owner turns voice on (a ~40 MB zip, never part of the
//      installer or auto-updates).
//   2. Repack it as the .tar.gz the WebAssembly engine reads.
//   3. Serve it at a fixed address, zehen-voice://models/<file>, so the
//      engine's own IndexedDB cache recognises it on the next start and
//      skips re-reading the archive.
//
// Models live in <userData>/voice-models. Nothing here runs unless the
// renderer asks.

const { app, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { zipToTarGz, repairTarGz } = require('./voiceArchive');

const SCHEME = 'zehen-voice';

// Small Vosk models (Apache 2.0). Small models also let the engine take a
// word list at runtime, which the big ones do not.
const MODELS = {
  hi: {
    name: 'vosk-model-small-hi-0.22',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip',
    label: 'Hindi + Hinglish',
    sizeMB: 42,
  },
  'en-in': {
    name: 'vosk-model-small-en-in-0.4',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip',
    label: 'Indian English',
    sizeMB: 36,
  },
};

// Must run before app 'ready' — main.js requires this module at the top.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const modelsDir = () => path.join(app.getPath('userData'), 'voice-models');
// "-2" = archives with folder entries. The engine caches by address, so a
// new name also keeps it from reusing a half-saved copy of an older one.
const archiveFile = (m) => `${m.name}-2.tar.gz`;
const archivePath = (m) => path.join(modelsDir(), archiveFile(m));

// The first build wrote archives without folder entries, which the engine
// can't cache, so voice never finished loading. Rebuild such a file once
// instead of downloading the model again.
function repairOld(m) {
  const old = path.join(modelsDir(), `${m.name}.tar.gz`);
  if (!fs.existsSync(old) || fs.existsSync(archivePath(m))) return;
  try {
    const tmp = `${archivePath(m)}.part`;
    fs.writeFileSync(tmp, repairTarGz(fs.readFileSync(old)));
    fs.renameSync(tmp, archivePath(m));
  } catch (e) {
    console.warn('[voice] could not rebuild old model archive:', e.message);
  }
  try { fs.rmSync(old, { force: true }); } catch { /* leave it */ }
}

function status(lang) {
  const m = MODELS[lang];
  if (!m) return { ok: false, error: 'Unknown language' };
  repairOld(m);
  let installed = false, bytes = 0;
  try { const st = fs.statSync(archivePath(m)); installed = st.size > 0; bytes = st.size; } catch { /* not yet */ }
  return { ok: true, lang, label: m.label, sizeMB: m.sizeMB, installed, bytes, url: `${SCHEME}://models/${archiveFile(m)}` };
}

// ── download ────────────────────────────────────────────────────────
const inFlight = new Map();

async function download(lang, onProgress) {
  const m = MODELS[lang];
  if (!m) throw new Error('Unknown language');
  if (inFlight.has(lang)) return inFlight.get(lang);
  const job = (async () => {
    fs.mkdirSync(modelsDir(), { recursive: true });
    const res = await net.fetch(m.url);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || m.sizeMB * 1048576;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, lastSent = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (got - lastSent > 512 * 1024) { lastSent = got; onProgress({ lang, received: got, total }); }
    }
    onProgress({ lang, received: got, total, converting: true });
    const tgz = zipToTarGz(Buffer.concat(chunks));
    const tmp = `${archivePath(m)}.part`;
    fs.writeFileSync(tmp, tgz);
    fs.renameSync(tmp, archivePath(m));
    return status(lang);
  })();
  inFlight.set(lang, job);
  try { return await job; } finally { inFlight.delete(lang); }
}

function remove(lang) {
  const m = MODELS[lang];
  if (!m) return { ok: false, error: 'Unknown language' };
  for (const f of [archivePath(m), path.join(modelsDir(), `${m.name}.tar.gz`)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  }
  return status(lang);
}

function init({ window }) {
  protocol.handle(SCHEME, async (req) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const u = new URL(req.url);
    const file = path.basename(decodeURIComponent(u.pathname));
    const known = Object.values(MODELS).find((m) => archiveFile(m) === file);
    if (u.host !== 'models' || !known || !fs.existsSync(archivePath(known))) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    const res = await net.fetch(pathToFileURL(archivePath(known)).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Content-Type', 'application/gzip');
    headers.set('Content-Length', String(fs.statSync(archivePath(known)).size));
    return new Response(res.body, { status: 200, headers });
  });

  ipcMain.handle('voice:model-status', (_e, lang) => status(lang));
  ipcMain.handle('voice:model-remove', (_e, lang) => remove(lang));
  ipcMain.handle('voice:model-download', async (_e, lang) => {
    try {
      return await download(lang, (p) => {
        const w = window();
        if (w && !w.isDestroyed()) w.webContents.send('voice:model-progress', p);
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { init, MODELS };
