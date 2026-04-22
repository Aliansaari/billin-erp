const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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
    // Page size in microns (1 mm = 1000 µm). Only set if the caller gave us
    // explicit dimensions — omitting it falls back to printer-default paper.
    if (paperWidthMm) {
      opts.pageSize = {
        width: Math.round(paperWidthMm * 1000),
        height: Math.round((paperHeightMm || paperWidthMm * 3) * 1000),
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
