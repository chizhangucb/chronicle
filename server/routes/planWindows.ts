import type { Express, Request, Response } from 'express';
import { computePlanWindows } from '../planWindows.ts';

export function mountPlanWindows(app: Express): void {
  // Claude subscription rate windows (5h / 7d / top-tier). OUTBOUND + OPT-IN-OFF:
  // returns {enabled:false} unless the user turned on `planWindows` in Settings.
  // NOT cached (it is a live quota read; and it must re-check the opt-in each time).
  app.get('/plan-windows', async (_req: Request, res: Response) => {
    try {
      res.json(await computePlanWindows());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
