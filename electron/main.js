const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// `app.isPackaged` is the canonical "are we running from a packaged
// .exe?" signal. NODE_ENV-based detection breaks in packaged builds
// because nothing sets NODE_ENV in customer installs — the result was
// the app trying to connect to Vite (`http://localhost:5173`) which
// only runs on the dev machine, producing a blank screen + no logs.
const isDev = !app.isPackaged;

// ── File logging for packaged builds ────────────────────────────────
//
// Packaged Electron apps don't write to a console anywhere by default,
// so a blank-screen-on-launch failure leaves the user (and us) with
// nothing to debug. We mirror every stdout/stderr write to a logfile
// so customers can share `<homedir>/.billing-erp/app.log` when
// reporting issues.
//
// In dev we skip this — the dev shell already shows logs, and we don't
// want two copies of every line.
function setupFileLogging() {
  if (isDev) return;
  try {
    const logDir = path.join(os.homedir(), '.billing-erp');
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
    console.log(`[main] log starting — Billing ERP ${app.getVersion?.() || ''}`);
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
// up two Billing ERP windows by double-launching the Electron binary —
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
      console.log(`[Billing ERP] server reachable after ${attempts} attempt(s) (${Date.now() - start} ms)`);
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`[Billing ERP] server unreachable after ${attempts} attempts (${Date.now() - start} ms)`);
  return false;
}

async function createWindow() {
  // Window-state persistence: remember last size + position across
  // launches so a customer who's adjusted the window doesn't have to
  // re-do it every time they open the app. Stored as a small JSON
  // sidecar next to the user's data folder so it survives reinstalls.
  const stateFile = path.join(
    require('os').homedir(),
    '.billing-erp',
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
    // Hard floor: Tally-Prime-style strict minimum so dragging the
    // corner can never break the layout. 1280×800 is wide enough for
    // the sidebar + main content on every modern Indian retail PC
    // (1366×768 fits 1280×800 with a tiny margin; 1920×1080 has plenty).
    minWidth:  1280,
    minHeight: 800,
    resizable:    true,         // resizing IS allowed — just bounded by minWidth/minHeight
    maximizable:  true,
    minimizable:  true,
    center:       !useState,    // only center on first launch; respect saved x/y after
    title: 'Billing ERP',
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

  // Production: load from the local Express server. Clear the renderer
  // cache first so a previous broken-build cache (e.g. an old asset hash
  // that 404s now) can't paint a blank window forever. The cost is a
  // re-download on every launch (~3 MB total, trivial on LAN/loopback).
  try { await mainWindow.webContents.session.clearCache(); } catch {}

  const ok = await waitForServer(SERVER_URL);
  if (!ok) {
    // Show a clear error page rather than a blank window. The user can
    // start the server, then click Retry to reload.
    const html = `<!doctype html><meta charset="utf-8"><title>Billing ERP — server unreachable</title>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">
  <div style="max-width:560px">
    <h1 style="margin:0 0 8px;font-weight:700;letter-spacing:-.5px">Couldn't reach the server</h1>
    <p style="margin:0 0 20px;color:#94a3b8;font-size:15px;line-height:1.55">
      The Billing ERP app expected the database server to be running at
      <code style="background:#1e293b;padding:2px 6px;border-radius:4px;color:#fda4af">${SERVER_URL}</code>
      but no response came back from <code>/api/health</code> in 15 s.
    </p>
    <ol style="text-align:left;margin:0 auto 22px;color:#cbd5e1;font-size:14px;line-height:1.7;max-width:420px">
      <li>Open Command Prompt in the Billing ERP folder.</li>
      <li>Run <code style="background:#1e293b;padding:2px 6px;border-radius:4px">npm run server</code>.</li>
      <li>Wait until you see "Database connected successfully".</li>
      <li>Click Retry below.</li>
    </ol>
    <button onclick="location.reload()" style="background:#22c55e;color:#0f172a;border:none;padding:10px 24px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px">Retry</button>
    <p style="margin:18px 0 0;color:#64748b;font-size:12px">Or set <code>BILLING_ERP_SERVER_URL</code> to point at a server on your LAN.</p>
  </div>
</body>`;
    await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return;
  }

  await mainWindow.loadURL(SERVER_URL);

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

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
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
    // Page size in microns (1 mm = 1000 µm). Coerce to Number FIRST — Sequelize
    // returns DECIMAL columns as strings like "0.00", which are truthy in JS, so
    // a simple `paperHeightMm || fallback` kept the zero and Electron rejected
    // the pageSize with "height and width properties are required". Number("0.00")
    // is 0 (falsy), which then correctly triggers the 3× width fallback used for
    // thermal roll paper with no fixed height.
    const w = Number(paperWidthMm);
    const h = Number(paperHeightMm);
    if (w > 0 && !Number.isNaN(w)) {
      const effH = (h > 0 && !Number.isNaN(h)) ? h : w * 3;
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

app.whenReady().then(() => {
  // Spawn the API server INSIDE the electron main process when running
  // as a packaged build — the user shouldn't have to run `npm run server`
  // separately. In dev this is a no-op; the dev script already runs the
  // server on its own.
  bootstrapServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
