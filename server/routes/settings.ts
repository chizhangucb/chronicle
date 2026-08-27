import type { Express, Request, Response } from 'express';
import { readConfig, writeConfig, startAutoSync, stopAutoSync, autoSyncStatus, runIncrementalSync, type ConfigPatch } from '../autosync.ts';
import { DEFAULT_MINOR_ACTIVE_MS, DEFAULT_MINOR_MESSAGE_COUNT } from '../noiseGate.ts';

export function mountSettings(app: Express): void {
  // ---- Auto-sync & settings ----
  // Settings live in ~/.chronicle/config.json.
  app.get('/settings', (_req: Request, res: Response) => {
    const cfg = readConfig();
    res.json({
      autoSync: cfg.autoSync !== false,
      autoSyncPaused: cfg.autoSyncPaused === true,
      minorActiveMsThreshold: (cfg.minorActiveMsThreshold as number | undefined) ?? DEFAULT_MINOR_ACTIVE_MS,
      minorMessageCountThreshold: (cfg.minorMessageCountThreshold as number | undefined) ?? DEFAULT_MINOR_MESSAGE_COUNT,
      planWindows: cfg.planWindows === true,
    });
  });

  app.patch('/settings', (req: Request, res: Response) => {
    const patch: ConfigPatch = {};
    if (typeof req.body?.autoSync === 'boolean') patch.autoSync = req.body.autoSync;
    if (typeof req.body?.autoSyncPaused === 'boolean') patch.autoSyncPaused = req.body.autoSyncPaused;
    if (typeof req.body?.minorActiveMsThreshold === 'number') patch.minorActiveMsThreshold = req.body.minorActiveMsThreshold;
    if (typeof req.body?.minorMessageCountThreshold === 'number') patch.minorMessageCountThreshold = req.body.minorMessageCountThreshold;
    if (typeof req.body?.planWindows === 'boolean') patch.planWindows = req.body.planWindows;
    const cfg = writeConfig(patch);
    if ('autoSync' in patch) (patch.autoSync ? startAutoSync() : stopAutoSync());
    res.json({
      autoSync: cfg.autoSync !== false,
      autoSyncPaused: cfg.autoSyncPaused === true,
      minorActiveMsThreshold: (cfg.minorActiveMsThreshold as number | undefined) ?? DEFAULT_MINOR_ACTIVE_MS,
      minorMessageCountThreshold: (cfg.minorMessageCountThreshold as number | undefined) ?? DEFAULT_MINOR_MESSAGE_COUNT,
      planWindows: cfg.planWindows === true,
    });
  });

  app.get('/autosync/status', (_req: Request, res: Response) => res.json(autoSyncStatus()));

  // Manual trigger (also fired on incremental-sync backstop / fs-watch).
  app.post('/autosync/run', async (_req: Request, res: Response) => {
    res.json(await runIncrementalSync());
  });
}
