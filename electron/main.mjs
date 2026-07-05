import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } from 'electron';
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
    webPreferences: { contextIsolation: true },
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

// Update check (NFR-7 lite): polls a releases feed; full silent auto-update
// needs a signed publish pipeline — deferred until distribution is set up.
const UPDATE_FEED = process.env.CHRONICLE_UPDATE_FEED
  || 'https://api.github.com/repos/kite-ai/chronicle/releases/latest';

async function checkForUpdates(interactive = true) {
  try {
    const res = await fetch(UPDATE_FEED, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (latest && latest !== current) {
      const { response } = await dialog.showMessageBox({
        message: `Chronicle ${latest} is available (you have ${current}).`,
        buttons: ['Download', 'Later'],
      });
      if (response === 0) shell.openExternal(release.html_url);
    } else if (interactive) {
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
});

app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay alive in tray */ });
