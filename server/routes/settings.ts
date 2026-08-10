import type { Express, Request, Response } from 'express';
import { readConfig, writeConfig, startAutoSync, stopAutoSync, autoSyncStatus, runIncrementalSync, type ChronicleConfig, type ConfigPatch } from '../autosync.ts';

declare global {
  // eslint-disable-next-line no-var
  var __chronicleOnSettings: ((cfg: ChronicleConfig) => void) | undefined;
}

export function mountSettings(app: Express): void {
  // ---- Auto-sync & settings ----
  // Settings live in ~/.chronicle/config.json. launchAtLogin is applied by the
  // Electron shell via an optional hook on globalThis (the server layer stays
  // Electron-free); in browser/standalone modes the toggle is stored but inert.
  app.get('/settings', (_req: Request, res: Response) => {
    const cfg = readConfig();
    res.json({ autoSync: cfg.autoSync !== false, launchAtLogin: cfg.launchAtLogin === true });
  });

  app.patch('/settings', (req: Request, res: Response) => {
    const patch: ConfigPatch = {};
    if (typeof req.body?.autoSync === 'boolean') patch.autoSync = req.body.autoSync;
    if (typeof req.body?.launchAtLogin === 'boolean') patch.launchAtLogin = req.body.launchAtLogin;
    const cfg = writeConfig(patch);
    if ('autoSync' in patch) (patch.autoSync ? startAutoSync() : stopAutoSync());
    if ('launchAtLogin' in patch) { try { globalThis.__chronicleOnSettings?.(cfg); } catch {} }
    res.json({ autoSync: cfg.autoSync !== false, launchAtLogin: cfg.launchAtLogin === true });
  });

  app.get('/autosync/status', (_req: Request, res: Response) => res.json(autoSyncStatus()));

  // Manual trigger (also called by Electron on powerMonitor resume).
  app.post('/autosync/run', async (_req: Request, res: Response) => {
    res.json(await runIncrementalSync());
  });
}
