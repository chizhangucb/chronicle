// Preload (CommonJS, sandboxed). Exposes a minimal updater API to the renderer
// via contextBridge. Present ONLY in the Electron shell — in the dev/standalone
// (browser) run modes window.chronicleUpdater is undefined, so the UI degrades
// to hiding the update toast entirely.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chronicleUpdater', {
  onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, info) => cb(info)),
  onAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  relaunch: () => ipcRenderer.invoke('update:relaunch'),
  check: () => ipcRenderer.invoke('update:check'),
});

// Opens an external https URL in the user's real system browser. Present ONLY in
// the Electron shell; in dev/standalone (browser) window.chronicleShell is undefined
// and src/shell.js falls back to window.open (a normal new tab).
contextBridge.exposeInMainWorld('chronicleShell', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});
