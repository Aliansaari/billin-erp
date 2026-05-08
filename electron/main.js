const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const isDev = process.env.NODE_ENV !== 'production';

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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // No minWidth / minHeight — the React app is fully responsive (sidebar
    // auto-collapses, tables scroll horizontally, dashboards stack). Letting
    // the user shrink the window arbitrarily means a billing counter with a
    // half-height monitor or a vertical slice of a wide screen still works.
    minWidth: 320,
    minHeight: 400,
    title: 'Billing ERP',
    show: false,                // wait until we've decided what to load
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
