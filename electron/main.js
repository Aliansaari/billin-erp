const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

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

  // Stage the HTML to a temp file rather than a data: URL. Earlier we
  // encoded the document as `data:text/html;charset=utf-8,${encodeURIComponent(html)}` —
  // that path silently produces an empty / broken PDF when the encoded
  // URL exceeds the renderer's URL-length cap or when the HTML contains
  // characters that disagree with `loadURL`'s parser. A real `loadFile`
  // sidesteps both issues, lets relative paths inside the HTML resolve,
  // and gives a useful "did-fail-load" signal we can surface to the
  // operator.
  const tempName = `bill-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.html`;
  const tempPath = path.join(os.tmpdir(), tempName);
  await fs.promises.writeFile(tempPath, html, 'utf8');

  // Window viewport must match the paper width so CSS layout reflows at
  // the same aspect ratio printToPDF will capture. Earlier we used a
  // fixed 1400×1800 viewport and let printToPDF squish whatever rendered
  // into an 80mm thermal page — the result was a PDF page with a wildly
  // off aspect ratio that some viewers (SumatraPDF) refused to render.
  //
  // CSS px ≈ paper_mm × 96 / 25.4. Default to A4 if no paper size in the
  // payload. Capped at 2000px tall so the window is always reasonable.
  const PX_PER_MM = 96 / 25.4;
  const cssW = Math.max(280, Math.round(((Number(paperWidthMm)  || 210)) * PX_PER_MM));
  const cssH = Math.max(400, Math.min(2400,
    Math.round(((Number(paperHeightMm) || 297)) * PX_PER_MM) + 200));
  const win = new BrowserWindow({
    show: false,
    width:  cssW,
    height: cssH,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: false, contextIsolation: true },
  });
  // Capture any did-fail-load events so a render failure surfaces back
  // to the renderer instead of producing a silent blank PDF.
  let loadErr = null;
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    loadErr = `did-fail-load (${code}) ${desc}`;
  });
  try {
    await win.loadFile(tempPath);
    if (loadErr) return { error: loadErr };

    // Wait for the document to be fully loaded AND fonts to be available
    // before snapshotting to PDF. Without this, printToPDF occasionally fires
    // mid-layout and produces a PDF whose page object resolves but whose
    // /Contents stream is empty — the viewer sees a valid page with no
    // drawing operators and reports "Couldn't render the page".
    await win.webContents.executeJavaScript(
      'new Promise(res => {' +
      '  const done = () => Promise.all([' +
      '    document.fonts?.ready || Promise.resolve(),' +
      '    new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))' +
      '  ]).then(() => res(true));' +
      '  if (document.readyState === "complete") return done();' +
      '  window.addEventListener("load", done);' +
      '})'
    ).catch(() => {});
    // Final settle tick — gives layout a frame to flush after fonts resolve.
    // 400ms is generous; matches the timing successful Electron printToPDF
    // setups in the wild use to avoid mid-paint snapshots.
    await new Promise(r => setTimeout(r, 400));

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
    // Buffer.slice + toString('ascii') is explicit about the encoding so
    // a future Buffer→Uint8Array migration doesn't accidentally break the
    // magic-byte check.
    if (!buffer || buffer.length < 100
        || Buffer.from(buffer).slice(0, 4).toString('ascii') !== '%PDF') {
      return { error: 'Empty or invalid PDF output from renderer' };
    }
    const dir = app.getPath('downloads');
    const filePath = path.join(dir, safeName);
    await fs.promises.writeFile(filePath, Buffer.from(buffer));
    return { filePath };
  } catch (e) {
    console.error('[pdf:save]', e);
    return { error: e.message };
  } finally {
    // Clean up the staged HTML and close the offscreen window. Both are
    // best-effort — leaving a stray temp file isn't a correctness bug.
    fs.promises.unlink(tempPath).catch(() => {});
    setTimeout(() => { try { win.close(); } catch {} }, 500);
  }
});

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
