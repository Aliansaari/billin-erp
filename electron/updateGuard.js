/**
 * Update guard — never start ZEHEN in the middle of its own update.
 *
 * Updates install silently when ZEHEN closes. That takes about a minute, and
 * nothing is on screen meanwhile, so people naturally open ZEHEN again. Before
 * this guard, that launch started the database while the installer was
 * stopping it and replacing its files ("incomplete PostgreSQL installation"),
 * and the window sat on "Preparing your workspace…" until the PC restarted.
 *
 * How it works:
 *   - Just before the installer runs, markInstalling() writes
 *     ~/.zehen/update-installing.json.
 *   - At start-up, waitIfInstalling() looks for that marker. While the
 *     installer is still running it shows "Finishing the update…" and waits.
 *     When the installer is done:
 *       · this is the new version → remove the marker and start normally;
 *       · this is the old binary (the install replaced it underneath us) →
 *         relaunch once, so the new version starts.
 *   - A marker older than 10 minutes is stale (installer crashed or was
 *     cancelled) and is ignored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow } = require('electron');

const MARKER = path.join(os.homedir(), '.zehen', 'update-installing.json');
const STALE_MS = 10 * 60 * 1000;
const WAIT_MAX_MS = 6 * 60 * 1000;
// The NSIS update installer, and the old version's silent uninstaller it runs.
const INSTALLER_RE = /^"(ZEHEN-Setup[^"]*\.exe|Un_A\.exe|Uninstall ZEHEN\.exe)"/im;

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return null; }
}
function clearMarker() { try { fs.unlinkSync(MARKER); } catch { /* not there */ } }

function markInstalling(version) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ version: version || null, from: app.getVersion(), at: Date.now() }));
  } catch (e) { console.error('[update-guard] could not write marker:', e.message); }
}

function installerRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(false);
      resolve(INSTALLER_RE.test(String(out || '')));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showWaitingWindow() {
  const win = new BrowserWindow({
    width: 440, height: 230, resizable: false, minimizable: false, maximizable: false, frame: false,
    show: false, center: true, backgroundColor: '#1d1814', webPreferences: { sandbox: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><title>ZEHEN</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1d1814;color:#f5eee2;font-family:system-ui,'Segoe UI',sans-serif;text-align:center">
  <div style="padding:24px">
    <div style="width:28px;height:28px;margin:0 auto 16px;border:3px solid #f5eee233;border-top-color:#d9673f;border-radius:50%;animation:s 0.9s linear infinite"></div>
    <div style="font-size:16px;font-weight:700">Finishing the ZEHEN update…</div>
    <div style="font-size:13px;color:#cbbfae;margin-top:8px;line-height:1.5">ZEHEN will open by itself in a moment.<br>Your data is safe.</div>
  </div>
  <style>@keyframes s{to{transform:rotate(360deg)}}</style>
</body>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * Call at start-up, before the database or the main window starts.
 * Resolves { handover: true } when this process is exiting / relaunching, else
 * { handover: false, win } — win is the waiting window if one was shown;
 * the caller closes it once its own window is up (closing the last window
 * would quit the app).
 */
async function waitIfInstalling() {
  const m = readMarker();
  if (!m) return { handover: false };
  if (!m.at || Date.now() - m.at > STALE_MS) { clearMarker(); return { handover: false }; }

  let win = null;
  const started = Date.now();
  // The installer starts a moment after ZEHEN exits; in the first seconds keep
  // waiting even if it is not visible yet (unless this already is the new version).
  const isNew = m.version && m.version === app.getVersion();
  while ((await installerRunning()) || (!isNew && Date.now() - m.at < 15000)) {
    if (!win) {
      console.log('[update-guard] an update is still installing — waiting for it to finish');
      win = showWaitingWindow();
    }
    if (Date.now() - started > WAIT_MAX_MS) break;
    await sleep(1500);
  }

  const current = app.getVersion();
  if (!m.version || m.version === current || m.relaunched) {
    console.log(`[update-guard] update finished (running ${current}) — starting normally`);
    clearMarker();
    return { handover: false, win };
  }
  // The installer replaced the program while this (older) copy was starting:
  // start the new one instead. Only once, so a failed install can't loop.
  console.log(`[update-guard] running ${current} but ${m.version} was installed — relaunching`);
  try { fs.writeFileSync(MARKER, JSON.stringify({ ...m, relaunched: true })); } catch { /* ignore */ }
  app.relaunch();
  app.exit(0);
  return { handover: true };
}

module.exports = { markInstalling, waitIfInstalling, clearMarker };
