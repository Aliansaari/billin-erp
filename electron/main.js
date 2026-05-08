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
