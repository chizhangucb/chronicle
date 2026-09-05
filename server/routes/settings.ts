import type { Express, Request, Response } from 'express';
import { readConfig, writeConfig, startAutoSync, stopAutoSync, autoSyncStatus, runIncrementalSync, type ConfigPatch } from '../autosync.ts';
import { DEFAULT_MINOR_ACTIVE_MS, DEFAULT_MINOR_MESSAGE_COUNT } from '../noiseGate.ts';

// A stored budget is only meaningful as a positive number; anything else reads
// out as null ("no budget set"). Keeps GET and PATCH responses consistent.
function normalizeBudget(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function mountSettings(app: Express): void {
  // ---- Auto-sync & settings ----
  // Settings live in ~/.chronicle/config.json.
  app.get('/settings', (_req: Request, res: Response) => {
    const cfg = readConfig();
    res.json({
      autoSync: cfg.autoSync !== false,
      autoSyncPaused: cfg.autoSyncPaused === true,
      ask: cfg.ask === true,
      minorActiveMsThreshold: (cfg.minorActiveMsThreshold as number | undefined) ?? DEFAULT_MINOR_ACTIVE_MS,
      minorMessageCountThreshold: (cfg.minorMessageCountThreshold as number | undefined) ?? DEFAULT_MINOR_MESSAGE_COUNT,
      planWindows: cfg.planWindows !== false,
      monthlyBudget: normalizeBudget(cfg.monthlyBudget),
    });
  });

  app.patch('/settings', (req: Request, res: Response) => {
    const patch: ConfigPatch = {};
    if (typeof req.body?.autoSync === 'boolean') patch.autoSync = req.body.autoSync;
    if (typeof req.body?.autoSyncPaused === 'boolean') patch.autoSyncPaused = req.body.autoSyncPaused;
    if (typeof req.body?.ask === 'boolean') patch.ask = req.body.ask;
    if (typeof req.body?.minorActiveMsThreshold === 'number') patch.minorActiveMsThreshold = req.body.minorActiveMsThreshold;
    if (typeof req.body?.minorMessageCountThreshold === 'number') patch.minorMessageCountThreshold = req.body.minorMessageCountThreshold;
    if (typeof req.body?.planWindows === 'boolean') patch.planWindows = req.body.planWindows;
    // Monthly budget (CHI-366): a positive number sets it; null / 0 / a
    // non-finite value clears it back to "no budget set".
    if ('monthlyBudget' in (req.body ?? {})) {
      const raw = req.body.monthlyBudget;
      patch.monthlyBudget = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    }
    const cfg = writeConfig(patch);
    if ('autoSync' in patch) (patch.autoSync ? startAutoSync() : stopAutoSync());
    res.json({
      autoSync: cfg.autoSync !== false,
      autoSyncPaused: cfg.autoSyncPaused === true,
      ask: cfg.ask === true,
      minorActiveMsThreshold: (cfg.minorActiveMsThreshold as number | undefined) ?? DEFAULT_MINOR_ACTIVE_MS,
      minorMessageCountThreshold: (cfg.minorMessageCountThreshold as number | undefined) ?? DEFAULT_MINOR_MESSAGE_COUNT,
      planWindows: cfg.planWindows !== false,
      monthlyBudget: normalizeBudget(cfg.monthlyBudget),
    });
  });

  app.get('/autosync/status', (_req: Request, res: Response) => res.json(autoSyncStatus()));

  // Manual trigger (also fired on incremental-sync backstop / fs-watch).
  app.post('/autosync/run', async (_req: Request, res: Response) => {
    res.json(await runIncrementalSync());
  });
}
