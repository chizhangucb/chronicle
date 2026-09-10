import type { Express, Request, Response } from 'express';
import { computePlanWindows } from '../planWindows.ts';

export function mountPlanWindows(app: Express): void {
  // Claude subscription rate windows (5h / 7d / top-tier). OUTBOUND, OPT-OUT,
  // DEFAULT ON: it reads the operator's own windows with the operator's own
  // token unless `planWindows` was switched off in Settings, in which case it
  // returns {claudeEnabled:false} and goes nowhere. NOT cached (it is a live
  // read, and it must re-check the toggle every time).
  app.get('/plan-windows', async (_req: Request, res: Response) => {
    try {
      res.json(await computePlanWindows());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
