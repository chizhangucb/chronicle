import { readConfig, writeConfig, startAutoSync, stopAutoSync, autoSyncStatus, runIncrementalSync } from '../autosync.js';

export function mountSettings(app) {
  // ---- Auto-sync & settings ----
  // Settings live in ~/.chronicle/config.json. launchAtLogin is applied by the
  // Electron shell via an optional hook on globalThis (the server layer stays
  // Electron-free); in browser/standalone modes the toggle is stored but inert.
  app.get('/settings', (req, res) => {
    const cfg = readConfig();
    res.json({ autoSync: cfg.autoSync !== false, launchAtLogin: cfg.launchAtLogin === true });
  });

  app.patch('/settings', (req, res) => {
    const patch = {};
    if (typeof req.body?.autoSync === 'boolean') patch.autoSync = req.body.autoSync;
    if (typeof req.body?.launchAtLogin === 'boolean') patch.launchAtLogin = req.body.launchAtLogin;
    const cfg = writeConfig(patch);
    if ('autoSync' in patch) (patch.autoSync ? startAutoSync() : stopAutoSync());
    if ('launchAtLogin' in patch) { try { globalThis.__chronicleOnSettings?.(cfg); } catch {} }
    res.json({ autoSync: cfg.autoSync !== false, launchAtLogin: cfg.launchAtLogin === true });
  });

  app.get('/autosync/status', (req, res) => res.json(autoSyncStatus()));

  // Manual trigger (also called by Electron on powerMonitor resume).
  app.post('/autosync/run', async (req, res) => {
    res.json(await runIncrementalSync());
  });
}
