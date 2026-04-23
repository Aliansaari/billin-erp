const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // Print bridge. The renderer never talks to printers directly — it asks
  // main, which owns the BrowserWindow that can silent-print. See main.js
  // ipcMain handlers for implementation.
  listPrinters: () => ipcRenderer.invoke('print:list-printers'),
  printSilent: (payload) => ipcRenderer.invoke('print:silent', payload),

  // Generate a PDF from HTML and WRITE IT TO DISK in main — returns the
  // absolute filePath. The earlier round-trip-buffer approach produced a PDF
  // that Acrobat rejected ("cannot render") because IPC structured-clone of
  // large number arrays subtly corrupts the bytes on some Electron builds.
  // Doing the fs.writeFile in main (with the raw Buffer) sidesteps that.
  savePDF: (payload) => ipcRenderer.invoke('pdf:save', payload),

  // Shell helpers so the renderer can open a file in the system default app
  // or pop a File Explorer window with the file already selected — used by
  // the WhatsApp flow so the operator can drag the fresh PDF into the chat.
  openPath:          (p) => ipcRenderer.invoke('shell:open-path', p),
  showItemInFolder:  (p) => ipcRenderer.invoke('shell:show-item', p),
});
