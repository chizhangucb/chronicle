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
