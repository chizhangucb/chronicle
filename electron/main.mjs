import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 41730;
const URL = `http://localhost:${PORT}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let win = null;
let tray = null;
let quitting = false;

// Single-instance lock (NFR-6)
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { showWindow(); });

async function startBackend() {
  const { startServer } = await import(path.join(root, 'server', 'standalone.js'));
  await startServer(PORT);
}

function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1440, height: 900,
    title: 'Chronicle',
    backgroundColor: '#0e1116',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
  });
  win.loadURL(URL);
  // Closing the window keeps the MCP Hub alive in the tray (FR-MCP-13)
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function buildTray() {
  // 16x16 clock glyph, generated as a data URL so we ship no binary assets
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVR4nKWTUQ6AIAxDW+9/aP2SIHZlA/tHNvZoywDgTgmwCwUgvWkA7Ea1zMxSTM/MTLU2vFXKZuoSpJRShVpjA3F16dPZAvsWl4vpVW+wjdEDCLROnRvNlxJgBOwBRs0r4DVBFtxeZR2s+g22Fdt/1oQTQLQ/Y5W7fLoHkVdY+xtQNRHtDwvIRjXlnyleZfvzMTnwx2f6AKQ5Hjry5UK/AAAAAElFTkSuQmCC');
  tray = new Tray(icon);
  tray.setToolTip('Chronicle — MCP Hub running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Chronicle', click: showWindow },
    { label: 'MCP Hub endpoint', sublabel: `${URL}/mcp`, click: () => shell.openExternal(`${URL}`) },
    { type: 'separator' },
    { label: 'Check for updates', click: checkForUpdates },
    { type: 'separator' },
    { label: 'Quit (stops MCP Hub)', click: () => { quitting = true; app.quit(); } },
  ]));
}

// Auto-update via electron-updater (NFR-7). Reads the github publish feed baked
// into app-update.yml at build time (owner/repo in package.json build.publish).
// autoUpdater only installs when the running app AND the update are signed by the
// same Developer ID — so this stays dormant until the first signed release.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:available', { version: info.version });
});
autoUpdater.on('update-downloaded', (info) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:downloaded', { version: info.version });
});
autoUpdater.on('error', (err) => {
  console.error('[updater]', err?.message || err);
});

// quitAndInstall triggers a real quit; let the window's close handler through
// instead of hiding to tray.
app.on('before-quit-for-update', () => { quitting = true; });

ipcMain.handle('update:relaunch', () => { quitting = true; autoUpdater.quitAndInstall(); });
ipcMain.handle('update:check', () => checkForUpdates(false));

async function checkForUpdates(interactive = false) {
  if (!app.isPackaged) {
    if (interactive) dialog.showMessageBox({ message: 'Updates are only available in the packaged app.' });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const current = app.getVersion();
    if (interactive && latest && latest === current) {
      dialog.showMessageBox({ message: `Chronicle ${current} is up to date.` });
    }
  } catch (err) {
    if (interactive) dialog.showMessageBox({ message: `Update check unavailable: ${err.message}` });
  }
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox('Chronicle', `Backend failed to start: ${err.message}`);
    app.quit();
    return;
  }
  buildTray();
  showWindow();
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
});

app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay alive in tray */ });
