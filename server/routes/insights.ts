import type { Express, Request, Response } from 'express';
import { computeInsights } from '../insights.ts';

export function mountInsights(app: Express): void {
  // computeInsights is async (its per-project commit counts now run
  // concurrently via commitCountSinceAsync rather than blocking the event
  // loop serially — see server/insights.ts) — await it and guard with
  // try/catch so a git failure surfaces as a normal 500, not an unhandled
  // rejection.
  app.get('/insights', async (req: Request, res: Response) => {
    const days = Number(req.query.days) || null;
    try {
      res.json(await computeInsights(days));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
