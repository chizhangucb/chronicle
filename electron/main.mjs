import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, powerMonitor } from 'electron';
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
  // Route any https navigation that would open a new window (target="_blank",
  // window.open) to the system browser instead of spawning a child BrowserWindow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window keeps auto-sync alive in the tray
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function buildTray() {
  // 16x16 clock glyph, generated as a data URL so we ship no binary assets
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVR4nKWTUQ6AIAxDW+9/aP2SIHZlA/tHNvZoywDgTgmwCwUgvWkA7Ea1zMxSTM/MTLU2vFXKZuoSpJRShVpjA3F16dPZAvsWl4vpVW+wjdEDCLROnRvNlxJgBOwBRs0r4DVBFtxeZR2s+g22Fdt/1oQTQLQ/Y5W7fLoHkVdY+xtQNRHtDwvIRjXlnyleZfvzMTnwx2f6AKQ5Hjry5UK/AAAAAElFTkSuQmCC');
  tray = new Tray(icon);
  tray.setToolTip('Chronicle — auto-sync running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Chronicle', click: showWindow },
    { label: 'Sync now', click: () => fetch(`${URL}/api/autosync/run`, { method: 'POST' }).catch(() => {}) },
    { type: 'separator' },
    { label: 'Check for updates', click: checkForUpdates },
    { type: 'separator' },
    { label: 'Quit (stops auto-sync)', click: () => { quitting = true; app.quit(); } },
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

// Sponsorship links (and any external https URL) open in the user's real browser,
// never an in-app BrowserWindow. Scheme-restricted to https for safety.
ipcMain.handle('shell:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
});

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

// chronicle://session/<id> deep links (dashboard integrations). The renderer
// watches location.hash; we just focus the window and set it.
app.setAsDefaultProtocolClient('chronicle');
function handleDeepLink(url) {
  const m = /^chronicle:\/\/session\/([^/?#]+)/.exec(url || '');
  if (!m) return;
  showWindow();
  win?.webContents.executeJavaScript(`location.hash = 'session=${encodeURIComponent(m[1])}'`).catch(() => {});
}
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });
app.on('second-instance', (_e, argv) => {
  const link = argv?.find((a) => a.startsWith('chronicle://'));
  if (link) handleDeepLink(link);
});

// launchAtLogin: applied when the server writes settings (hook set below) and
// once at startup from ~/.chronicle/config.json.
function applyLoginItem(cfg) {
  try { app.setLoginItemSettings({ openAtLogin: cfg?.launchAtLogin === true }); } catch {}
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
  // Auto-sync on system wake: macOS drops fs-watch events across sleep, so a
  // resume is the main missed-event window. The server module lives in this
  // process (standalone), so the hook + fetch both work.
  globalThis.__chronicleOnSettings = applyLoginItem;
  applyLoginItem(await import('node:fs').then((fs) => {
    try { return JSON.parse(fs.readFileSync(path.join(app.getPath('home'), '.chronicle', 'config.json'), 'utf8')); } catch { return {}; }
  }));
  powerMonitor.on('resume', () => {
    fetch(`${URL}/api/autosync/run`, { method: 'POST' }).catch(() => {});
  });
});

app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay alive in tray */ });
