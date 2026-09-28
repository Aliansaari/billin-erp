/**
 * Software updates, delivered from download.zehenapp.com.
 * ──────────────────────────────────────────────────────
 *
 * A release is published (scripts/release/publish.js) to the R2 bucket behind
 * download.zehenapp.com/updates: the installer, its blockmap for small
 * differential downloads, and latest.yml describing it. This module checks
 * that feed and, with the owner's permission, downloads and installs.
 *
 * ══ The rules ══
 *
 * 1. Never interrupt billing. An update installs only when ZEHEN is closing,
 *    or when the owner presses "Restart and update". Nothing restarts on its
 *    own mid-day.
 * 2. Only install what WE signed. Installers are not Authenticode-signed, so
 *    Windows' signature check cannot vouch for them. Each release instead
 *    carries an Ed25519 signature (zehenSignature in latest.yml) over the
 *    installer's SHA-512, made with a private key that never leaves the
 *    release PC. A file that does not verify against UPDATE_PUBLIC_KEY is
 *    refused, so a tampered download host cannot push anything.
 * 3. The owner decides, the way a phone or a Mac does it:
 *    - A check the owner starts ("Check for updates") never downloads on its
 *      own. It shows the update, its size and what's new, and waits for
 *      "Update Now".
 *    - "Download updates automatically" lets the background check (every
 *      6 hours) fetch a new version quietly, ready to install.
 *    - "Install when ZEHEN closes" installs a downloaded update at close.
 *      Off: it waits for "Restart Now".
 * 4. Offline is normal. A failed check is recorded and retried later; it is
 *    never shown as an error popup and never blocks anything.
 *
 * Postgres runs from inside the install folder and keeps running after the
 * app closes (see embeddedPostgres.js), which would lock files the installer
 * must replace. So right before an install we stop ZEHEN's own cluster; the
 * next launch starts it again.
 */

const { app, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEED_URL = 'https://download.zehenapp.com/updates';
const RELEASE_NOTES_URL = 'https://zehenapp.com/releases';
// Public half of the update-signing key (scripts/release/keygen.js).
const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEADXNnCspOxn8NZGlGcigw755e/m1Hg41K1nzVdBNrkl0=';

const FIRST_CHECK_MS = 90_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const SETTINGS_PATH = path.join(os.homedir(), '.zehen', 'update-settings.json');

let updater = null;
let getWindow = () => null;
let beforeInstall = () => {};
let lastInfo = null;
let timer = null;
let manualCheck = false;

const state = {
  status: 'idle',          // idle | checking | up-to-date | available | downloading | downloaded | error | unavailable
  reason: null,            // why updates are unavailable on this install
  currentVersion: app.getVersion(),
  version: null,
  releaseDate: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
  auto: true,               // kept for older pages: both automatic settings on
  autoDownload: true,
  autoInstall: true,
  size: null,               // bytes of the installer
  releaseName: null,
  releaseNotes: [],         // plain lines, from the feed
  transferred: null,
  total: null,
  bytesPerSecond: null,
  releaseNotesUrl: RELEASE_NOTES_URL,
};

function readSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* first run */ }
  // Older installs saved one switch, "auto"; it meant both download and install.
  const legacy = raw.auto === undefined ? true : raw.auto !== false;
  return {
    autoDownload: raw.autoDownload === undefined ? legacy : raw.autoDownload !== false,
    autoInstall: raw.autoInstall === undefined ? legacy : raw.autoInstall !== false,
  };
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[updater] could not save settings:', e.message);
  }
  return next;
}

function publish(patch = {}) {
  Object.assign(state, patch);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('updates:state', { ...state }); } catch { /* window reloading */ }
  }
}

/** Is `filePath` byte-for-byte a release we signed? Returns null or an error message. */
function verifyRelease(filePath) {
  try {
    const sig = lastInfo && lastInfo.zehenSignature;
    if (!sig) return 'This update is not signed by ZEHEN, so it was not installed.';
    const digest = crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
    if (lastInfo.sha512 && digest !== lastInfo.sha512) return 'The downloaded file is damaged. It will be downloaded again.';
    const key = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(`zehen-release:${lastInfo.version}:${digest}`), key, Buffer.from(sig, 'base64'));
    return ok ? null : 'This update\'s signature did not match, so it was not installed.';
  } catch (e) {
    return `Could not verify the update (${e.message}).`;
  }
}

function applyPrefs({ autoDownload, autoInstall }) {
  state.autoDownload = !!autoDownload;
  state.autoInstall = !!autoInstall;
  state.auto = state.autoDownload && state.autoInstall;
  if (!updater) return;
  // Downloads are always started by us (see rule 3), never by the library.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = state.autoInstall;
}

/** Release notes from the feed as plain lines ("- item" markdown or HTML <li>). */
function notesOf(info) {
  let n = info && info.releaseNotes;
  if (Array.isArray(n)) n = n.map((x) => (x && x.note) || '').join('\n');
  if (!n || typeof n !== 'string') return [];
  return n.replace(/<\/?(ul|ol|p|br)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<[^>]+>/g, '')
    .split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 12);
}

async function download() {
  if (!updater || !lastInfo || (state.status !== 'available' && state.status !== 'error')) return { ...state };
  try {
    publish({ status: 'downloading', progress: 0, transferred: 0, total: state.size, bytesPerSecond: null, error: null });
    await updater.downloadUpdate();
  } catch (e) { publish({ status: 'error', error: friendly(e) }); }
  return { ...state };
}

async function check({ manual = false } = {}) {
  if (!updater) return { ...state };
  // An update already downloaded stays ready; checking again changes nothing.
  if (state.status === 'downloaded' || state.status === 'downloading') return { ...state };
  try {
    manualCheck = manual;
    publish({ status: 'checking', error: null });
    await updater.checkForUpdates();
  } catch (e) {
    // Offline or the host is unreachable: say so quietly, try again later.
    publish({ status: 'error', error: friendly(e), lastCheckedAt: Date.now() });
  }
  return { ...state };
}

function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR_/i.test(m)) return 'No internet connection. ZEHEN will check again later.';
  if (/404/.test(m)) return 'No update information is published yet.';
  return m.split('\n')[0].slice(0, 200);
}

async function installNow() {
  if (state.status !== 'downloaded' || !updater) return false;
  try { beforeInstall(); } catch (e) { console.error('[updater] beforeInstall:', e.message); }
  // Silent install, then start the new version.
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

/**
 * Wire up updates. Safe to call on every launch; does nothing in dev or on
 * a LAN client build (those are updated by reinstalling the client setup).
 */
function init({ window: windowGetter, clientMode, onBeforeInstall }) {
  getWindow = windowGetter || getWindow;
  beforeInstall = onBeforeInstall || beforeInstall;
  applyPrefs(readSettings());

  ipcMain.handle('updates:get-state', () => ({ ...state }));
  ipcMain.handle('updates:check', () => check({ manual: true }));
  ipcMain.handle('updates:set-auto', (_e, auto) => {          // older pages: one switch for both
    applyPrefs(writeSettings({ autoDownload: !!auto, autoInstall: !!auto }));
    publish();
    return { ...state };
  });
  ipcMain.handle('updates:set-prefs', (_e, prefs = {}) => {
    const cur = readSettings();
    const next = writeSettings({
      autoDownload: prefs.autoDownload === undefined ? cur.autoDownload : !!prefs.autoDownload,
      autoInstall: prefs.autoInstall === undefined ? cur.autoInstall : !!prefs.autoInstall,
    });
    applyPrefs(next);
    publish();
    return { ...state };
  });
  ipcMain.handle('updates:download', () => download());
  ipcMain.handle('updates:install-now', () => installNow());

  if (!app.isPackaged) { state.status = 'unavailable'; state.reason = 'dev'; return; }
  if (clientMode) { state.status = 'unavailable'; state.reason = 'client'; return; }

  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    state.status = 'unavailable'; state.reason = 'missing';
    console.error('[updater] electron-updater not available:', e.message);
    return;
  }

  updater.logger = { info: (m) => console.log('[updater]', m), warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => {} };
  updater.setFeedURL({ provider: 'generic', url: FEED_URL });
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Our signature check replaces Windows' Authenticode check (see rule 2).
  // Overriding verifySignature itself, not just verifyUpdateCodeSignature:
  // the library skips the latter entirely (fail-open) when app-update.yml is
  // missing or names no publisher. This way the check always runs.
  updater.verifySignature = async (file) => verifyRelease(file);
  updater.verifyUpdateCodeSignature = async (_publisherNames, file) => verifyRelease(file);
  applyPrefs(readSettings());

  updater.on('update-available', (info) => {
    lastInfo = info;
    const size = Array.isArray(info.files) && info.files[0] && info.files[0].size ? info.files[0].size : null;
    publish({
      status: 'available', version: info.version, releaseDate: info.releaseDate || null, progress: null,
      size, releaseName: info.releaseName || null, releaseNotes: notesOf(info), lastCheckedAt: Date.now(),
    });
    // Only the quiet background check may start a download on its own.
    if (!manualCheck && state.autoDownload) download();
    manualCheck = false;
  });
  updater.on('update-not-available', () => { manualCheck = false; publish({ status: 'up-to-date', version: null, releaseNotes: [], releaseName: null, size: null, lastCheckedAt: Date.now() }); });
  updater.on('download-progress', (p) => publish({
    status: 'downloading', progress: Math.round(p.percent || 0),
    transferred: p.transferred || null, total: p.total || state.size, bytesPerSecond: p.bytesPerSecond || null,
  }));
  updater.on('update-downloaded', (info) => {
    lastInfo = info;
    publish({ status: 'downloaded', version: info.version, progress: 100 });
  });
  updater.on('error', (e) => publish({ status: 'error', error: friendly(e), lastCheckedAt: Date.now() }));

  // Installing at close: make room for the installer first (rule 1 + Postgres).
  app.on('before-quit', () => {
    if (state.status === 'downloaded' && state.autoInstall) {
      try { beforeInstall(); } catch (e) { console.error('[updater] beforeInstall:', e.message); }
    }
  });

  const first = setTimeout(check, FIRST_CHECK_MS);
  if (first.unref) first.unref();
  timer = setInterval(check, CHECK_EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { init, _internal: { verifyRelease, setLastInfo: (i) => { lastInfo = i; } } };
