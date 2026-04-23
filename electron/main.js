const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV !== 'production';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Billing ERP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.setMenuBarVisibility(false);
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

// Generate a PDF from HTML in an off-screen BrowserWindow and write it to
// the user's Downloads folder. Returns { filePath, error }. Writing in main
// avoids the IPC structured-clone corruption that made earlier PDFs open as
// "cannot render" — the Buffer from printToPDF goes straight to fs.writeFile
// without round-tripping through a number[] across the IPC bridge.
ipcMain.handle('pdf:save', async (_ev, payload) => {
  const { html, fileName, paperWidthMm, paperHeightMm, marginsMm } = payload || {};
  if (!html) return { error: 'No HTML supplied' };

  let safeName;
  try { safeName = assertSafeName(sanitizeForFs(fileName) || 'bill.pdf'); }
  catch (e) { return { error: e.message }; }
  if (!/\.pdf$/i.test(safeName)) safeName += '.pdf';

  // sandbox:true prevents execution of the fonts.ready wait below on some
  // Electron builds — we drop it here (the window only loads trusted HTML
  // that we generated ourselves, so there's no attack surface). offscreen
  // canvas + transparent background keeps fonts at full fidelity.
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { offscreen: false, contextIsolation: true },
  });
  try {
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await win.loadURL(dataUrl);

    // Wait for the document to be fully loaded AND fonts to be available
    // before snapshotting to PDF. Without this, printToPDF occasionally fires
    // mid-layout and produces a PDF that opens but displays "Cannot render
    // page" because the /Resources stream references font metrics the
    // renderer hadn't populated yet.
    await win.webContents.executeJavaScript(
      'new Promise(res => {' +
      '  const done = () => (document.fonts?.ready || Promise.resolve()).then(() => res(true));' +
      '  if (document.readyState === "complete") return done();' +
      '  window.addEventListener("load", done);' +
      '})'
    ).catch(() => {});
    // Final settle tick — gives layout a frame to flush after fonts resolve.
    await new Promise(r => setTimeout(r, 120));

    const w = Number(paperWidthMm);
    const h = Number(paperHeightMm);
    const pdfOpts = {
      printBackground: true,
      margins: marginsMm ? {
        top:    Number(marginsMm.top    ?? 10) / 25.4,  // mm → inches
        right:  Number(marginsMm.right  ?? 10) / 25.4,
        bottom: Number(marginsMm.bottom ?? 10) / 25.4,
        left:   Number(marginsMm.left   ?? 10) / 25.4,
      } : undefined,
    };
    if (w > 0 && !Number.isNaN(w)) {
      const effH = (h > 0 && !Number.isNaN(h)) ? h : w * 3;
      // Electron 28 printToPDF expects pageSize width/height in microns.
      pdfOpts.pageSize = {
        width:  Math.round(w    * 1000),
        height: Math.round(effH * 1000),
      };
    }

    const buffer = await win.webContents.printToPDF(pdfOpts);
    // Guard: a zero-length or non-PDF buffer means Chromium bailed silently.
    // Surface it instead of writing a corrupt file the user would open later.
    if (!buffer || buffer.length < 100 || buffer.slice(0, 4).toString() !== '%PDF') {
      return { error: 'Empty or invalid PDF output from renderer' };
    }
    const dir = app.getPath('downloads');
    const filePath = path.join(dir, safeName);
    await fs.promises.writeFile(filePath, buffer);
    return { filePath };
  } catch (e) {
    console.error('[pdf:save]', e);
    return { error: e.message };
  } finally {
    setTimeout(() => { try { win.close(); } catch {} }, 500);
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
