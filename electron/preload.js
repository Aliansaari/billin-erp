const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // Print bridge. The renderer never talks to printers directly — it asks
  // main, which owns the BrowserWindow that can silent-print. See main.js
  // ipcMain handlers for implementation.
  listPrinters: () => ipcRenderer.invoke('print:list-printers'),
  printSilent: (payload) => ipcRenderer.invoke('print:silent', payload),

  // Renderer-built PDF blob (jsPDF) → write to Downloads. Bytes go over
  // IPC as a Uint8Array so the structured-clone path stays type-stable;
  // main wraps in Buffer and writes.
  //
  // The legacy `pdf:save` (HTML-to-PDF via offscreen Chromium printToPDF)
  // bridge was removed: every viewer in the wild was hit-or-miss with
  // its output ("Couldn't render the page" in SumatraPDF, font subset
  // errors in Acrobat). Bills, statements, and the report PDFs now build
  // their bytes with jsPDF in the renderer and ship them through this
  // single, reliable bridge.
  saveBlobToDownloads: (payload) => ipcRenderer.invoke('pdf:save-blob', payload),

  // Shell helpers so the renderer can open a file in the system default app
  // or pop a File Explorer window with the file already selected — used by
  // the WhatsApp flow so the operator can drag the fresh PDF into the chat.
  openPath:          (p) => ipcRenderer.invoke('shell:open-path', p),
  showItemInFolder:  (p) => ipcRenderer.invoke('shell:show-item', p),

  // LAN thin-client mode: read / persist the host PC's server URL the
  // client connects to. Only used by client builds and the client setup
  // screen; harmless (unused) in a normal host build.
  getClientServerUrl: () => ipcRenderer.invoke('client:get-server-url'),
  setClientServerUrl: (url) => ipcRenderer.invoke('client:set-server-url', url),

  // App-exit confirmation. Main intercepts the window close and asks the
  // renderer to show the themed confirm + sign the user out; the renderer
  // sends `app:exit-confirmed` back only when the user agrees to quit.
  onConfirmExit: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:confirm-exit', handler);
    return () => ipcRenderer.removeListener('app:confirm-exit', handler);
  },
  confirmExit: () => ipcRenderer.send('app:exit-confirmed'),
});

// ── UI-settings persistence mirror ──────────────────────────────────
//
// Home/dashboard layout, theme and barcode-label prefs live in the
// renderer's localStorage. To keep them alive across reinstalls and any
// storage reset, we mirror just these keys to a ~/.billing-erp JSON file
// (read/written by main). On boot we restore any MISSING key BEFORE the
// SPA's scripts read storage; then back up changes periodically + on exit.
// Strictly best-effort: every step is wrapped so the preload never throws.
const UI_SETTINGS_KEYS = [
  'erp-home-settings',      // Command Center (home) layout
  'erp-dashboard-settings', // Dashboard tiles + config
  'erp-theme',              // Theme / appearance
  'barcode_label_layout',   // Barcode label designer layout
  'barcode_company_name',   // Barcode label company name
  'barcode_printer_name',   // Barcode label printer
  'barcode_silent_print',   // Barcode silent-print toggle
];

(function restoreUiSettings() {
  try {
    const saved = ipcRenderer.sendSync('ui-settings:load-sync') || {};
    for (const k of UI_SETTINGS_KEYS) {
      // Restore ONLY keys this profile is missing — never overwrite a
      // value the operator already has here.
      if (saved[k] != null && window.localStorage.getItem(k) === null) {
        window.localStorage.setItem(k, saved[k]);
      }
    }
  } catch { /* first run / storage unavailable — behave as before */ }
})();

function backupUiSettings() {
  try {
    const out = {};
    for (const k of UI_SETTINGS_KEYS) {
      const v = window.localStorage.getItem(k);
      if (v != null) out[k] = v;
    }
    if (Object.keys(out).length) ipcRenderer.invoke('ui-settings:save', out);
  } catch { /* best-effort */ }
}

try {
  // Initial capture once the SPA has hydrated, then a slow cadence, plus
  // teardown — cheap ~1 KB JSON writes that keep the sidecar fresh.
  setTimeout(backupUiSettings, 4000);
  setInterval(backupUiSettings, 60000);
  window.addEventListener('pagehide', backupUiSettings);
  window.addEventListener('beforeunload', backupUiSettings);
} catch { /* ignore */ }
