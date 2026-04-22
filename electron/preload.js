const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // Print bridge. The renderer never talks to printers directly — it asks
  // main, which owns the BrowserWindow that can silent-print. See main.js
  // ipcMain handlers for implementation.
  listPrinters: () => ipcRenderer.invoke('print:list-printers'),
  printSilent: (payload) => ipcRenderer.invoke('print:silent', payload),
});
