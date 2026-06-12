const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { startEmbeddedPostgres } = require('./embeddedPostgres');

// ── userData folder ──────────────────────────────────────────────────
//
// Electron keeps the renderer's localStorage (login token, theme, layout)
// under app.getPath('userData'), derived from the product name. We pin it
// explicitly to "ZEHEN" so the location is stable and obvious regardless
// of how electron-builder names things. Business data lives separately in
// ~/.zehen + Postgres, so this folder only holds UI session state. Must
// run before the 'ready' event and any window/session use, so it sits
// here at module load.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'ZEHEN'));
} catch { /* best-effort — fall back to Electron's default if unavailable */ }

// `app.isPackaged` is the canonical "are we running from a packaged
// .exe?" signal. NODE_ENV-based detection breaks in packaged builds
// because nothing sets NODE_ENV in customer installs — the result was
// the app trying to connect to Vite (`http://localhost:5173`) which
// only runs on the dev machine, producing a blank screen + no logs.
const isDev = !app.isPackaged;

// ── LAN thin-client mode ────────────────────────────────────────────
//
// A "client" build does NOT run its own bundled server or touch a local
// database — it only points at the shop's host PC over the LAN. It's
// produced by `npm run dist:client`, which bakes `clientMode:true` into
// the packaged package.json via electron-builder extraMetadata. In dev
// you can force it with CLIENT_MODE=1.
//
// Strictly additive: a normal (host) build never sets clientMode, so
// CLIENT_MODE is false and every branch below is bypassed — the host
// installer behaves exactly as before.
let _appPkg = {};
try { _appPkg = require('../package.json'); } catch { /* ignore */ }
const CLIENT_MODE = isDev ? process.env.CLIENT_MODE === '1' : !!_appPkg.clientMode;

// Where the thin client remembers the host PC's URL — alongside the
// other ~/.zehen sidecars so it survives reinstalls.
const CLIENT_CFG_PATH = path.join(os.homedir(), '.zehen', 'client-config.json');

// ── UI-settings sidecar ─────────────────────────────────────────────
//
// The home/dashboard layout, theme and barcode-label preferences live in
// the renderer's localStorage (Zustand `persist`). localStorage normally
// survives reinstalls (userData isn't deleted), but it's fragile — a
// corrupted LevelDB, a Chromium storage reset, or moving to a new PC all
// wipe it, and the operator loses every layout/theme/barcode tweak.
//
// So we mirror just those keys to a plain JSON file under ~/.zehen
// (the same place window-state.json lives "so it survives reinstalls").
// The preload restores any MISSING key from here on boot and backs the
// current values up periodically. Purely additive + best-effort: if the
// file is absent or unreadable, the app behaves exactly as before.
const UI_SETTINGS_PATH = path.join(os.homedir(), '.zehen', 'ui-settings.json');

function readUiSettingsFile() {
  try {
    if (fs.existsSync(UI_SETTINGS_PATH)) {
      const obj = JSON.parse(fs.readFileSync(UI_SETTINGS_PATH, 'utf8'));
      if (obj && typeof obj === 'object') return obj;
    }
  } catch { /* corrupted / unreadable → treat as empty */ }
  return {};
}

function writeUiSettingsFile(obj) {
  try {
    if (!obj || typeof obj !== 'object') return;
    fs.mkdirSync(path.dirname(UI_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(UI_SETTINGS_PATH, JSON.stringify(obj), 'utf8');
  } catch { /* best-effort; never block the app on a settings-mirror write */ }
}

function readClientServerUrl() {
  // An explicit env override always wins (lets a deployer hard-pin it
  // via a desktop shortcut, skipping the setup screen).
  const envUrl = process.env.BILLING_ERP_SERVER_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  try {
    const j = JSON.parse(fs.readFileSync(CLIENT_CFG_PATH, 'utf8'));
    if (j && j.serverUrl) return String(j.serverUrl).replace(/\/+$/, '');
  } catch { /* not configured yet */ }
  return null;
}

function writeClientServerUrl(url) {
  fs.mkdirSync(path.dirname(CLIENT_CFG_PATH), { recursive: true });
  fs.writeFileSync(CLIENT_CFG_PATH, JSON.stringify({ serverUrl: url }), 'utf8');
}

// First-run / unreachable screen for the client. Self-contained HTML
// (data: URL — no server needed) whose input calls the preload bridge
// to persist the host URL; the main process then re-drives the load.
// `failedUrl` is set when a previously-saved address didn't answer.
async function showClientSetupPage(opts) {
  const failedUrl = (opts && opts.failedUrl) || '';
  const current = failedUrl || readClientServerUrl() || 'http://192.168.1.';
  const banner = failedUrl
    ? `<p style="margin:0 0 16px;color:#fda4af;font-size:14px">Couldn't reach <code style="background:#1e293b;padding:2px 6px;border-radius:4px">${failedUrl}</code>. Check the address, and that the shop PC is on and running ZEHEN.</p>`
    : `<p style="margin:0 0 16px;color:#94a3b8;font-size:14px">Enter the address of the shop's main ZEHEN PC. Ask whoever set up the main computer for its IP.</p>`;
  const html = `<!doctype html><meta charset="utf-8"><title>ZEHEN — connect to shop PC</title>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;padding:24px">
  <div style="max-width:520px;width:100%">
    <h1 style="margin:0 0 6px;font-weight:700;letter-spacing:-.5px">Connect to the shop PC</h1>
    ${banner}
    <input id="u" value="${current}" placeholder="http://192.168.1.50:3001"
      style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:15px;outline:none" />
    <div id="msg" style="min-height:20px;margin:10px 2px;font-size:13px"></div>
    <button id="go" style="background:#B1472F;color:#0f172a;border:none;padding:11px 24px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px">Connect</button>
    <p style="margin:18px 0 0;color:#64748b;font-size:12px">The main PC must be on the same Wi-Fi / LAN and running ZEHEN.</p>
  </div>
  <script>
    var b=document.getElementById('go'),i=document.getElementById('u'),m=document.getElementById('msg');
    function submit(){
      var v=(i.value||'').trim();
      m.style.color='#94a3b8';m.textContent='Connecting…';b.disabled=true;
      Promise.resolve(window.electronAPI&&window.electronAPI.setClientServerUrl(v)).then(function(r){
        if(!r||!r.ok){m.style.color='#fda4af';m.textContent=(r&&r.error)||'Could not save. Check the address.';b.disabled=false;}
      }).catch(function(e){m.style.color='#fda4af';m.textContent=String(e);b.disabled=false;});
    }
    b.addEventListener('click',submit);
    i.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
    i.focus();i.select();
  </script>
</body>`;
  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// Client load sequence: clear cache → resolve host URL → wait → load,
// or fall back to the setup screen if unconfigured / unreachable.
async function loadClient() {
  try { await mainWindow.webContents.session.clearCache(); } catch { /* non-fatal */ }
  const url = readClientServerUrl();
  if (!url) { await showClientSetupPage(); return; }
  const ok = await waitForServer(url);
  if (!ok) { await showClientSetupPage({ failedUrl: url }); return; }
  await mainWindow.loadURL(url);
}

ipcMain.handle('client:get-server-url', () => readClientServerUrl());
ipcMain.handle('client:set-server-url', (_e, raw) => {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+/i.test(url)) {
    return { ok: false, error: 'Enter a full address like http://192.168.1.50:3001' };
  }
  try { writeClientServerUrl(url); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  // Re-drive the load now that we have a target (fire-and-forget; the
  // renderer just needs the {ok:true} ack).
  if (mainWindow && !mainWindow.isDestroyed()) loadClient();
  return { ok: true };
});

// UI-settings mirror. `load-sync` is SYNCHRONOUS on purpose: the preload
// must restore localStorage BEFORE the SPA's scripts (Zustand) read it,
// and a one-off ~1 KB file read is instant. `save` is async fire-and-forget.
ipcMain.on('ui-settings:load-sync', (e) => { e.returnValue = readUiSettingsFile(); });
ipcMain.handle('ui-settings:save', (_e, obj) => { writeUiSettingsFile(obj); return true; });

// Full app relaunch — used by the "Retry" button on the database-port
// conflict screen. The DB port is probed once at startup in the main
// process, so a renderer reload can't re-attempt it; only a fresh launch
// re-runs startEmbeddedPostgres. app.exit(0) bypasses the close-confirm
// (there's no session to protect on the error screen).
ipcMain.on('zehen:restart-app', () => { try { app.relaunch(); } catch {} app.exit(0); });

// ── File logging for packaged builds ────────────────────────────────
//
// Packaged Electron apps don't write to a console anywhere by default,
// so a blank-screen-on-launch failure leaves the user (and us) with
// nothing to debug. We mirror every stdout/stderr write to a logfile
// so customers can share `<homedir>/.zehen/app.log` when
// reporting issues.
//
// In dev we skip this — the dev shell already shows logs, and we don't
// want two copies of every line.
function setupFileLogging() {
  if (isDev) return;
  try {
    const logDir = path.join(os.homedir(), '.zehen');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'app.log');
    // Trim if oversized (keep last ~1 MB so the file doesn't grow
    // unbounded over years of use).
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1_000_000) {
        const tail = fs.readFileSync(logPath, 'utf8').slice(-500_000);
        fs.writeFileSync(logPath, tail);
      }
    } catch {}
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const stamp = () => new Date().toISOString();
    const tee = (origFn, level) => (...args) => {
      try {
        const line = `[${stamp()}][${level}] ` + args.map(a =>
          typeof a === 'string' ? a : (a && a.stack ? a.stack : JSON.stringify(a))
        ).join(' ') + '\n';
        stream.write(line);
      } catch {}
      try { origFn.apply(console, args); } catch {}
    };
    console.log   = tee(console.log,   'log');
    console.info  = tee(console.info,  'info');
    console.warn  = tee(console.warn,  'warn');
    console.error = tee(console.error, 'error');

    process.on('uncaughtException',  (err) => {
      console.error('[uncaughtException]', err && err.stack || err);
    });
    process.on('unhandledRejection', (err) => {
      console.error('[unhandledRejection]', err && err.stack || err);
    });
    console.log(`[main] log starting — ZEHEN ${app.getVersion?.() || ''}`);
  } catch { /* never crash on logging setup */ }
}
setupFileLogging();

// In a packaged build the user expects a single .exe — they shouldn't
// have to run `npm run server` in another terminal. Electron's main
// process IS Node, so we just require the server module here. server/
// calls app.listen() at the bottom of its boot, so by the time
// waitForServer resolves below, the API is reachable.
//
// In dev we DON'T require the server inline — `npm run dev` already
// spawns it as a separate process via `npm run server`, and we want
// nodemon-style restarts to work on server changes.
//
// `app.isPackaged` is the canonical "are we shipped as an .exe?"
// check. Don't use NODE_ENV — that varies by how the user launched.
function bootstrapServer() {
  if (CLIENT_MODE) {
    console.log('[main] CLIENT_MODE — thin LAN client, not starting a local server/DB');
    return;
  }
  if (app.isPackaged) {
    // Server lives at <asar>/server/index.js. The path is relative to
    // electron/main.js — one level up. Wrapped in a try so any startup
    // error surfaces in the logfile + the renderer's "couldn't reach
    // server" page rather than crashing the whole app silently.
    console.log('[main] bootstrapping server inside packaged app…');
    try {
      require('../server/index.js');
      console.log('[main] server module loaded; app.listen will fire async');
    } catch (e) {
      console.error('[main] bootstrapServer FAILED — server cannot start:');
      console.error(e && e.stack || e);
    }
  } else {
    console.log('[main] dev mode — assuming `npm run server` is running separately');
  }
}

let mainWindow = null;

/* Production deployment model
 * ───────────────────────────
 *
 * Electron loads the SPA from the local Express server (http://localhost:3001),
 * NOT from the on-disk file (file:///.../dist/index.html). This unifies the
 * loading path with browser-only LAN clients — both end up hitting the same
 * URL with the same `<base href="/">` and same /api/* origin — and avoids
 * a class of bugs where file:// resolves asset paths inconsistently or
 * where same-origin checks differ between the Electron renderer and a
 * browser tab.
 *
 * The user can override the URL via BILLING_ERP_SERVER_URL in env, useful
 * for client PCs whose Electron should connect to a different machine on
 * the LAN (e.g. set BILLING_ERP_SERVER_URL=http://192.168.1.50:3001 in a
 * desktop shortcut).
 *
 * The boot waits up to ~15 s for /api/health to respond before showing
 * the window, so the user doesn't see a "site can't be reached" page if
 * Electron launches a hair before the server finishes its DB warmup.
 */
// 127.0.0.1, not localhost: Node 18+ on Windows resolves "localhost" to
// the IPv6 ::1 by default, which doesn't connect to our IPv4-only
// 0.0.0.0 bind. Hard-coding the IPv4 loopback skips the resolver
// entirely. The user can still override BILLING_ERP_SERVER_URL on
// LAN-client PCs to point at the office's host machine.
const SERVER_URL = (process.env.BILLING_ERP_SERVER_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

// Ping a single URL with a hard timeout. Returns true iff the server
// returned a 200 within `timeoutMs`. Used by waitForServer below.
//
// We force `family: 4` because Node 18+ on Windows resolves `localhost`
// to `::1` (IPv6) by default — but our Express server binds to
// 0.0.0.0 (IPv4 only), so the IPv6 connection silently fails. Forcing
// IPv4 sidesteps the whole DNS dance.
function pingServer(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      const u = new URL(`${url}/api/health`);
      const req = http.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'GET',
        family: 4,
        timeout: timeoutMs,
      }, (res) => {
        res.resume();                                    // drain
        done(res.statusCode === 200);
      });
      req.on('error',   () => done(false));
      req.on('timeout', () => { req.destroy(); done(false); });
      req.end();
      // Hard fallback in case neither callback fires.
      setTimeout(() => done(false), timeoutMs + 200).unref();
    } catch { done(false); }
  });
}

// Single-instance guard. Prevents the user from accidentally stacking
// up two ZEHEN windows by double-launching the Electron binary —
// the second launch is denied a window and the existing window is
// brought to focus instead. Without this, an old broken instance can
// linger underneath a new launch and look like the new one is "blank".
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function waitForServer(url, totalTimeoutMs = 30000) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < totalTimeoutMs) {
    attempts += 1;
    if (await pingServer(url)) {
      console.log(`[ZEHEN] server reachable after ${attempts} attempt(s) (${Date.now() - start} ms)`);
      return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error(`[ZEHEN] server unreachable after ${attempts} attempts (${Date.now() - start} ms)`);
  return false;
}

async function createWindow() {
  // Window-state persistence: remember last size + position across
  // launches so a customer who's adjusted the window doesn't have to
  // re-do it every time they open the app. Stored as a small JSON
  // sidecar next to the user's data folder so it survives reinstalls.
  const stateFile = path.join(
    require('os').homedir(),
    '.zehen',
    'window-state.json',
  );
  let savedState = null;
  try {
    if (fs.existsSync(stateFile)) {
      savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch { /* ignore — corrupted state just falls back to defaults */ }

  // Default opens at the customer's primary-display work area minus a
  // 40-px safety margin so the window never paints over the taskbar /
  // hidden-window edges. Only used on the very first launch (or when
  // the saved state lives outside any current display).
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workAreaSize;        // already accounts for taskbar
  const defaultW = Math.max(1280, wa.width  - 40);
  const defaultH = Math.max(800,  wa.height - 40);

  // Validate saved state — reject sizes/positions that would paint the
  // window mostly off-screen (e.g. user docked on a second monitor that
  // has since been disconnected).
  let useState = null;
  if (savedState && savedState.width >= 1280 && savedState.height >= 800) {
    const inBounds = screen.getAllDisplays().some(d =>
      savedState.x >= d.bounds.x - 80 &&
      savedState.y >= d.bounds.y - 40 &&
      savedState.x <= d.bounds.x + d.bounds.width  - 200 &&
      savedState.y <= d.bounds.y + d.bounds.height - 100
    );
    if (inBounds) useState = savedState;
  }

  mainWindow = new BrowserWindow({
    width:     useState?.width  ?? defaultW,
    height:    useState?.height ?? defaultH,
    x:         useState?.x ?? undefined,    // undefined → centered
    y:         useState?.y ?? undefined,
    // Hard floor: a conservative strict minimum so dragging the
    // corner can never break the layout. 1280×800 is wide enough for
    // the sidebar + main content on every modern Indian retail PC
    // (1366×768 fits 1280×800 with a tiny margin; 1920×1080 has plenty).
    minWidth:  1280,
    minHeight: 800,
    resizable:    true,         // resizing IS allowed — just bounded by minWidth/minHeight
    maximizable:  true,
    minimizable:  true,
    center:       !useState,    // only center on first launch; respect saved x/y after
    title: 'ZEHEN',
    // Explicit window icon so the logo shows in the title bar + taskbar for
    // BOTH the host and client builds. Without this, Electron falls back to
    // the exe's embedded icon, which the client build doesn't always pick up
    // reliably. icon.ico ships inside electron/ (bundled via the package
    // `files` glob), so this path resolves in dev AND the packaged asar.
    icon: path.join(__dirname, 'icon.ico'),
    show: false,                // wait until we've decided what to load
    backgroundColor: '#0f172a', // matches the loading screen so no white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Persist size + position whenever the user resizes / moves so the
  // next launch picks up where they left off. Throttled via the OS's
  // own resize event coalescing — no extra debounce needed.
  const saveState = () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      // Don't save while the window is in a transient state (minimised
      // or maximised) — those bounds aren't what the user "chose".
      if (mainWindow.isMinimized() || mainWindow.isMaximized()) return;
      const b = mainWindow.getBounds();
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        width:  b.width, height: b.height, x: b.x, y: b.y,
      }), 'utf8');
    } catch { /* never crash on state save */ }
  };
  mainWindow.on('resize', saveState);
  mainWindow.on('move',   saveState);
  mainWindow.on('close',  saveState);

  // ── Exit confirmation + sign-out ──────────────────────────────────
  // The first close attempt (X button / Alt+F4) is intercepted: ask the
  // renderer to show the app-themed confirm dialog and sign the user
  // out. The renderer calls back `app:exit-confirmed` only when the
  // operator agrees, which flips the flag so the real close goes
  // through. The renderer de-dupes its own modal, so repeated X presses
  // never stack. If the renderer can't be reached we close immediately
  // so the user is never trapped.
  let exitConfirmed = false;
  mainWindow.on('close', (e) => {
    if (exitConfirmed) return;
    e.preventDefault();
    try { mainWindow.webContents.send('app:confirm-exit'); }
    catch { exitConfirmed = true; mainWindow.close(); }
  });
  ipcMain.on('app:exit-confirmed', () => {
    exitConfirmed = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  mainWindow.setMenuBarVisibility(false);
  // Always launch maximised. The width/height/x/y above act as the
  // "restore-down" bounds — i.e. what the user gets back when they click
  // the restore button next to the X. Calling maximize() BEFORE show()
  // avoids the brief windowed-then-maximised flicker on Windows.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Pipe the renderer's console messages back to Electron stdout so a
  // blank-screen JS error is visible in the launch terminal even when
  // the user can't open DevTools. Without this, runtime crashes inside
  // React mount silently leave a white window with no diagnostic
  // anywhere except DevTools.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['log', 'warning', 'error'][level] || 'log';
    // Skip the noisy AntD JS-only warnings; keep the rest.
    if (level >= 1) {
      console.log(`[renderer ${tag}] ${message}  (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] gone:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] did-fail-load:', code, desc, url);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
    return;
  }

  // LAN thin-client build: never starts/expects a local server — point
  // at the shop's host PC (configured once via the setup screen).
  if (CLIENT_MODE) {
    await loadClient();
    return;
  }

  // Show a loading screen instantly. Navigation to SERVER_URL is driven
  // from app.whenReady() after postgres + the API server are both up —
  // keeping this function lean so the window appears before any slow I/O.
  const loadingHtml = `<!doctype html><meta charset="utf-8"><title>ZEHEN</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{
  background:#0a0f1a;
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
  color:#e2e8f0;
  display:flex;align-items:center;justify-content:center;
  /* subtle radial glow behind the logo */
  background-image:
    radial-gradient(ellipse 600px 400px at 50% 45%, rgba(177,71,47,.07) 0%, transparent 70%),
    radial-gradient(ellipse 300px 300px at 50% 46%, rgba(177,71,47,.04) 0%, transparent 60%);
}

.splash{text-align:center;animation:fadeUp .8s ease-out both}

/* ── thunderbolt icon ── */
.icon-ring{
  width:80px;height:80px;margin:0 auto 28px;
  border-radius:22px;
  background:linear-gradient(135deg,rgba(177,71,47,.15) 0%,rgba(177,71,47,.05) 100%);
  border:1px solid rgba(177,71,47,.2);
  display:flex;align-items:center;justify-content:center;
  position:relative;
}
.icon-ring::before{
  content:'';position:absolute;inset:-4px;border-radius:26px;
  background:conic-gradient(from 0deg,transparent 0%,rgba(177,71,47,.3) 25%,transparent 50%);
  animation:ringGlow 3s linear infinite;
  mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1px));
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1px));
}
/* ZEHEN app mark */
.bolt{width:60px;height:60px;filter:drop-shadow(0 8px 18px rgba(177,71,47,.45))}

/* ── brand text ── */
.brand{font-size:28px;font-weight:700;letter-spacing:-.5px;margin-bottom:6px}
.brand span{
  background:linear-gradient(135deg,#e2e8f0 0%,#94a3b8 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  background-clip:text;
}
.tagline{font-size:12.5px;color:#94a3b8;letter-spacing:.3px;margin-bottom:40px}

/* ── progress bar ── */
.progress-track{
  width:220px;height:3px;margin:0 auto;border-radius:2px;
  background:rgba(51,65,85,.5);overflow:hidden;
}
.progress-fill{
  height:100%;width:0%;border-radius:2px;
  background:linear-gradient(90deg,#B1472F,#E26A4C);
  animation:load 12s cubic-bezier(.4,.0,.2,1) forwards;
  box-shadow:0 0 12px rgba(177,71,47,.4);
}

.status{
  margin-top:16px;font-size:13px;color:#64748b;letter-spacing:.2px;
  animation:pulse 2s ease-in-out infinite;
}

/* ── floating particles ── */
.particles{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.p{
  position:absolute;width:2px;height:2px;border-radius:50%;
  background:rgba(177,71,47,.3);
  animation:float linear infinite;
}
.p:nth-child(1){left:15%;animation-duration:18s;animation-delay:0s}
.p:nth-child(2){left:35%;animation-duration:22s;animation-delay:2s;width:3px;height:3px;opacity:.5}
.p:nth-child(3){left:55%;animation-duration:16s;animation-delay:4s}
.p:nth-child(4){left:75%;animation-duration:20s;animation-delay:1s;width:2.5px;height:2.5px;opacity:.4}
.p:nth-child(5){left:90%;animation-duration:24s;animation-delay:3s}
.p:nth-child(6){left:5%;animation-duration:19s;animation-delay:5s;opacity:.3}
.p:nth-child(7){left:45%;animation-duration:21s;animation-delay:6s;width:1.5px;height:1.5px}
.p:nth-child(8){left:65%;animation-duration:17s;animation-delay:2.5s;opacity:.35}

/* ── version badge ── */
.ver{
  position:fixed;bottom:20px;right:24px;
  font-size:11px;color:#334155;letter-spacing:.5px;
}

@keyframes fadeUp{
  from{opacity:0;transform:translateY(16px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes ringGlow{to{transform:rotate(360deg)}}
@keyframes load{
  0%{width:0%}
  15%{width:18%}
  40%{width:40%}
  60%{width:58%}
  80%{width:72%}
  95%{width:88%}
  100%{width:95%}
}
@keyframes pulse{
  0%,100%{opacity:.7}
  50%{opacity:1}
}
@keyframes float{
  0%{transform:translateY(100vh) scale(0);opacity:0}
  10%{opacity:1}
  90%{opacity:1}
  100%{transform:translateY(-10vh) scale(1);opacity:0}
}
</style>
<body>
  <div class="particles">
    <div class="p"></div><div class="p"></div><div class="p"></div><div class="p"></div>
    <div class="p"></div><div class="p"></div><div class="p"></div><div class="p"></div>
  </div>
  <div class="splash">
    <div class="icon-ring">
      <svg class="bolt" viewBox="677 116 692 702">
        <rect x="679" y="118" width="688" height="698" rx="150" ry="150" fill="rgb(176,73,42)"/>
        <path fill="rgb(250,245,230)" d="M 873.28 620.891 C 868.937 620.646 866.558 619.954 862.326 618.887 L 861.923 618.017 C 866.607 616.186 914.979 609.08 923.199 608.101 C 947.845 605.164 983.824 596.778 1007.37 595.712 C 999.997 603.096 989.926 613.778 982.362 620.452 L 1139.7 620.267 C 1149.52 620.237 1203.73 619.484 1210.01 620.642 L 1197.85 633.633 L 1210.03 645.326 C 1206.13 648.969 1201.16 653.358 1197.64 657.232 L 1210.09 668.609 C 1206.96 671.714 1200.64 677.649 1197.95 680.748 L 1210.06 692.343 C 1206.37 695.797 1201.05 700.486 1197.89 704.223 L 1210.27 716.711 C 1177.65 716.224 1145.21 716.481 1112.59 716.719 C 1036.85 717.272 960.809 715.668 885.088 716.828 C 872.793 689.373 853.967 650.109 843.325 622.673 C 846.339 619.305 866.138 621.355 873.28 620.891 z"/>
        <path fill="rgb(236,227,206)" d="M 1186.78 401.025 C 1191.5 400.962 1196.93 400.752 1201.59 401.038 C 1138.88 466.169 1071.53 531.652 1007.37 595.712 C 983.824 596.778 947.845 605.164 923.199 608.101 C 914.979 609.08 866.607 616.186 861.923 618.017 L 862.326 618.887 C 866.558 619.954 868.937 620.646 873.28 620.891 C 866.138 621.355 846.339 619.305 843.325 622.673 L 842.521 620.712 C 844.989 615.826 884.426 577.916 890.749 571.605 L 1036.41 426.46 C 1045.02 418.141 1053.48 409.668 1061.79 401.045 C 1100 401.169 1148.96 402.421 1186.78 401.025 z"/>
        <path fill="rgb(250,245,230)" d="M 848.882 304.846 L 1159.32 304.867 C 1173.87 336.011 1187.44 369.456 1201.59 401.038 C 1196.93 400.752 1191.5 400.962 1186.78 401.025 C 1148.96 402.421 1100 401.169 1061.79 401.045 L 848.892 401.073 L 848.882 304.846 z"/>
        <path fill="rgb(250,245,230)" d="M 1023.76 186.646 C 1027.58 189.293 1061.72 224.5 1067.77 230.491 L 1024.61 274.309 C 1021.08 272.805 986.03 236.573 980.103 230.593 L 1023.76 186.646 z"/>
      </svg>
    </div>
    <div class="brand"><span>ZEHEN</span></div>
    <div class="tagline">Smart billing &amp; business management software</div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="status">Preparing your workspace…</div>
  </div>
  <div class="ver">v1.0.0</div>
</body>`;
  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHtml));

  // Diagnostic auto-open of DevTools is OFF in production. The
  // renderer's console-message bridge above still pipes errors into
  // the launch terminal, so blank-window issues remain debuggable
  // without forcing DevTools onto every user. Re-enable by setting
  // BILLING_ERP_OPEN_DEVTOOLS=1 in env when needed.
  if (process.env.BILLING_ERP_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/* ════════════════════════════════════════════════════════════════════════
 *  Print IPC
 *  — Renderer asks for the list of printers or to silently print an HTML
 *    document to a specific device. Silent print uses an off-screen hidden
 *    BrowserWindow so the user never sees the system print dialog.
 * ══════════════════════════════════════════════════════════════════════ */

ipcMain.handle('print:list-printers', async () => {
  try {
    if (!mainWindow) return { printers: [], error: 'main window not ready' };
    const wc = mainWindow.webContents;
    let printers = [];
    if (typeof wc.getPrintersAsync === 'function') {
      printers = await wc.getPrintersAsync();
    } else if (typeof wc.getPrinters === 'function') {
      printers = wc.getPrinters();
    }
    // Normalise the shape; different Electron releases include different
    // optional fields (displayName vs name on macOS, description on Linux).
    const mapped = (printers || []).map(p => ({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description || '',
      status: p.status,
      isDefault: p.isDefault,
    }));
    return { printers: mapped };
  } catch (e) {
    console.error('[print:list-printers]', e);
    return { printers: [], error: e.message };
  }
});

// Silent print: spin up a hidden BrowserWindow with the rendered HTML,
// call webContents.print({silent:true,deviceName}), then close. Returning
// a Promise so the renderer awaits completion — avoids race where the
// window is GC'd before the print job is queued.
ipcMain.handle('print:silent', async (_ev, payload) => {
  const { html, deviceName, copies, paperWidthMm, paperHeightMm, marginsMm } = payload || {};
  if (!html) return { error: 'No HTML supplied' };

  // Coerce sizes up front. Sequelize returns DECIMAL columns as strings
  // ("0.00"), so Number() first; a 0/NaN height means "continuous roll".
  const w = Number(paperWidthMm);
  const h = Number(paperHeightMm);
  const MM_PER_PX = 25.4 / 96;   // 96 CSS px per inch
  // Render the offscreen window at the paper's pixel width so the content
  // height we measure below matches the printed layout (line wrapping etc.).
  const contentPxW = (w > 0 && !Number.isNaN(w)) ? Math.max(160, Math.ceil(w / MM_PER_PX)) : 800;

  const win = new BrowserWindow({ show: false, useContentSize: true, width: contentPxW, height: 1200, webPreferences: { sandbox: true } });
  try {
    // Load the HTML as a data: URL so we don't need a temp file.
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await win.loadURL(dataUrl);

    const opts = {
      silent: true,
      deviceName: deviceName || '',
      printBackground: true,
      copies: Math.max(1, Number(copies || 1)),
      margins: marginsMm ? {
        marginType: 'custom',
        top: (marginsMm.top ?? 10),
        right: (marginsMm.right ?? 10),
        bottom: (marginsMm.bottom ?? 10),
        left: (marginsMm.left ?? 10),
      } : { marginType: 'default' },
    };

    // Page size in microns (1 mm = 1000 µm).
    if (w > 0 && !Number.isNaN(w)) {
      let effH;
      if (h > 0 && !Number.isNaN(h)) {
        // Fixed page height (A4 / A5 / custom) — paginate normally; the
        // items-table header is meant to repeat per page on those.
        effH = h;
      } else {
        // Continuous roll: no fixed height. Size the page to the ACTUAL
        // rendered content height so the whole bill prints as ONE strip —
        // no page break, no repeated header — no matter how many items.
        // Previously this used a fixed width×3 height, which forced a page
        // break (and a repeated table header) on long bills (~37+ items).
        let effPx = 0;
        try {
          await win.webContents.executeJavaScript(
            'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
          ).catch(() => {});
          effPx = await win.webContents.executeJavaScript(
            'Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight))'
          );
        } catch { effPx = 0; }
        // Content height + a small tail so the cutter doesn't clip the last
        // line; clamp so a pathological value can't request a 10-metre page.
        effH = effPx > 0 ? Math.min(effPx * MM_PER_PX + 6, 6000) : (w * 3);
      }
      opts.pageSize = {
        width: Math.round(w * 1000),
        height: Math.round(effH * 1000),
      };
    }

    const result = await new Promise((resolve) => {
      win.webContents.print(opts, (success, failureReason) => {
        resolve({ success, failureReason: failureReason || null });
      });
    });
    return result;
  } catch (e) {
    return { error: e.message };
  } finally {
    setTimeout(() => { try { win.close(); } catch {} }, 500);
  }
});

// Sanitize a file name for cross-platform safety — strip path separators,
// control chars, trailing dots/spaces. Identical to the renderer's version;
// duplicated because preload can't easily share code with main.
function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

// Guard against caller supplying a path traversal target (..\..\secrets).
// Only allow file names with no separators.
function assertSafeName(name) {
  if (!name || /[\\/]|\0/.test(name)) throw new Error('Unsafe file name');
  return name;
}

// (Removed) The `pdf:save` handler that took raw HTML and rendered it to
// PDF via an offscreen BrowserWindow + `webContents.printToPDF` is gone.
// Despite many timing / viewport / temp-file fixes, certain viewers
// (SumatraPDF most prominently) consistently refused to render the
// resulting pages — the page object would be valid but the /Contents
// stream would be malformed or empty. Every PDF surface in the app now
// builds its bytes with jsPDF in the renderer and ships them through
// `pdf:save-blob` below; that's the single, reliable bridge.

// Write a renderer-built PDF blob (jsPDF Uint8Array) directly to the
// user's Downloads folder. Used by the bill / list PDF exports — far
// more robust than the printToPDF route since the bytes come pre-formed
// from jsPDF and just need a write-and-open hop.
ipcMain.handle('pdf:save-blob', async (_ev, payload) => {
  const { fileName, bytes } = payload || {};
  if (!bytes || !bytes.length) return { error: 'No bytes supplied' };
  let safeName;
  try { safeName = assertSafeName(sanitizeForFs(fileName) || 'document.pdf'); }
  catch (e) { return { error: e.message }; }
  if (!/\.pdf$/i.test(safeName)) safeName += '.pdf';

  try {
    const dir = app.getPath('downloads');
    const filePath = path.join(dir, safeName);
    await fs.promises.writeFile(filePath, Buffer.from(bytes));
    return { filePath };
  } catch (e) {
    console.error('[pdf:save-blob]', e);
    return { error: e.message };
  }
});

// Open a file in the OS default handler (double-click equivalent).
ipcMain.handle('shell:open-path', async (_ev, filePath) => {
  if (!filePath) return { error: 'No path' };
  const err = await shell.openPath(filePath);
  return err ? { error: err } : { ok: true };
});

// Pop a File Explorer window with the file pre-selected so the user can
// drag it into another app (e.g. a WhatsApp chat).
ipcMain.handle('shell:show-item', async (_ev, filePath) => {
  if (!filePath) return { error: 'No path' };
  shell.showItemInFolder(filePath);
  return { ok: true };
});

app.whenReady().then(async () => {
  const bootStart = Date.now();

  // ── 1. Show the window immediately ──────────────────────────────────
  // createWindow() renders a loading spinner and returns as soon as the
  // data: URL is painted. Postgres and the API server boot concurrently
  // in the steps below while the user already sees the app window.
  // We deliberately do NOT await — the function suspends at its internal
  // loadURL("data:...") await; since startEmbeddedPostgres now uses
  // async execFile, the event loop is free to deliver the did-finish-load
  // IPC that resolves that await, so the spinner appears almost instantly.
  createWindow();
  console.log(`[perf] window created +${Date.now() - bootStart}ms`);

  // ── 2. Start embedded postgres (non-blocking) ────────────────────────
  // startEmbeddedPostgres now uses execFile + TCP polling instead of
  // execFileSync + pg_ctl -w, so the event loop stays free the whole
  // time postgres is starting up (which can take 30-75 s on machines
  // where Windows Defender scans the binaries on first exec).
  let pgResult = null;
  try {
    const pgStart = Date.now();
    pgResult = await startEmbeddedPostgres({ clientMode: CLIENT_MODE });
    console.log(`[perf] postgres ready +${Date.now() - bootStart}ms (pg took ${Date.now() - pgStart}ms)`);
    console.log('[main] embedded postgres:', JSON.stringify(pgResult));
  } catch (e) {
    console.error('[main] startEmbeddedPostgres threw (continuing):', e);
  }

  // ── 2b. Port conflict: a DIFFERENT database program holds our port ───
  // Booting the server now would just fail to authenticate and leave the
  // user staring at a blank screen after a 30 s timeout. Show a clear,
  // actionable message instead (this is the classic "old Billing ERP still
  // running" case after a rebrand migration).
  if (pgResult && pgResult.reason === 'port-conflict' && app.isPackaged && !CLIENT_MODE) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const msg = (pgResult.message || `Another program is using the database port on this PC.`)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<!doctype html><meta charset="utf-8"><title>ZEHEN — database in use</title>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">
  <div style="max-width:560px">
    <div style="width:64px;height:64px;margin:0 auto 20px;border-radius:18px;background:linear-gradient(135deg,#B1472F,#8a3522);display:flex;align-items:center;justify-content:center;font-size:30px">⚠️</div>
    <h1 style="margin:0 0 10px;font-weight:700;letter-spacing:-.5px">Database port is in use</h1>
    <p style="margin:0 0 22px;color:#cbd5e1;font-size:15px;line-height:1.6">${msg}</p>
    <button onclick="(window.electronAPI&&window.electronAPI.restartApp)?window.electronAPI.restartApp():location.reload()" style="background:#B1472F;color:#fff;border:none;padding:11px 26px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px">Retry</button>
    <p style="margin:20px 0 0;color:#64748b;font-size:12px">After closing the other program, click Retry — or restart this PC and open ZEHEN again.</p>
  </div>
</body>`;
      await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    }
    return; // do NOT boot the server into a guaranteed failure
  }

  // ── 3. Boot the API server ───────────────────────────────────────────
  const serverStart = Date.now();
  bootstrapServer();
  console.log(`[perf] server bootstrap called +${Date.now() - bootStart}ms`);

  // ── 4. Navigate to the app once the server is reachable ─────────────
  // Only needed for packaged host builds; dev and CLIENT_MODE handle
  // their own navigation inside createWindow().
  if (app.isPackaged && !CLIENT_MODE) {
    // Only clear the renderer cache when the app version changes.
    // Clearing on every launch forces a full 3 MB SPA re-download and
    // re-parse, adding 5-15 s. Version-gated clearing handles the real
    // case (stale asset hash after an update) without the per-launch cost.
    const appVersion = app.getVersion?.() || '0';
    const versionCacheFile = path.join(os.homedir(), '.zehen', 'cached-version.txt');
    try {
      const last = fs.readFileSync(versionCacheFile, 'utf8').trim();
      if (last !== appVersion && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.webContents.session.clearCache();
        fs.writeFileSync(versionCacheFile, appVersion, 'utf8');
        console.log('[main] cache cleared for new version', appVersion);
      }
    } catch {
      try {
        if (mainWindow && !mainWindow.isDestroyed())
          await mainWindow.webContents.session.clearCache();
        fs.mkdirSync(path.dirname(versionCacheFile), { recursive: true });
        fs.writeFileSync(versionCacheFile, appVersion, 'utf8');
      } catch {}
    }

    const ok = await waitForServer(SERVER_URL);
    console.log(`[perf] waitForServer done +${Date.now() - bootStart}ms (ok=${ok})`);
    if (!ok) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const html = `<!doctype html><meta charset="utf-8"><title>ZEHEN — server unreachable</title>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">
  <div style="max-width:560px">
    <h1 style="margin:0 0 8px;font-weight:700;letter-spacing:-.5px">Couldn't reach the server</h1>
    <p style="margin:0 0 20px;color:#94a3b8;font-size:15px;line-height:1.55">
      The ZEHEN app expected the database server to be running at
      <code style="background:#1e293b;padding:2px 6px;border-radius:4px;color:#fda4af">${SERVER_URL}</code>
      but no response came back from <code>/api/health</code> in 30 s.
    </p>
    <ol style="text-align:left;margin:0 auto 22px;color:#cbd5e1;font-size:14px;line-height:1.7;max-width:420px">
      <li>Open Command Prompt in the ZEHEN folder.</li>
      <li>Run <code style="background:#1e293b;padding:2px 6px;border-radius:4px">npm run server</code>.</li>
      <li>Wait until you see "Database connected successfully".</li>
      <li>Click Retry below.</li>
    </ol>
    <button onclick="location.reload()" style="background:#B1472F;color:#0f172a;border:none;padding:10px 24px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px">Retry</button>
    <p style="margin:18px 0 0;color:#64748b;font-size:12px">Or set <code>BILLING_ERP_SERVER_URL</code> to point at a server on your LAN.</p>
  </div>
</body>`;
        await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      }
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(SERVER_URL);
      console.log(`[perf] app loaded +${Date.now() - bootStart}ms — total boot time`);
    }
  }
});

// Postgres is intentionally left running after the app closes so that the
// next launch hits the fast-path (TCP port already busy → skip pg_ctl,
// startup in <1 s instead of 30-75 s while Windows Defender scans the
// postgres binaries). The cluster shuts down automatically when Windows
// reboots; a clean shutdown via pg_ctl is not required for data safety
// because Postgres uses WAL and recovers from an unclean exit fine.
app.on('will-quit', () => { /* postgres stays running — see comment above */ });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
