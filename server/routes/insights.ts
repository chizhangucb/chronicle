import type { Express, Request, Response } from 'express';
import { computeInsights } from '../insights.ts';
import { cached } from '../cache.ts';

export function mountInsights(app: Express): void {
  // computeInsights is async (its per-project commit counts now run
  // concurrently via commitCountSinceAsync rather than blocking the event
  // loop serially — see server/insights.ts) — await it and guard with
  // try/catch so a git failure surfaces as a normal 500, not an unhandled
  // rejection. Cached by full request URL (encodes `days`); cached() stores
  // the in-flight promise itself, so concurrent requests for the same URL
  // share one computation, and a rejection evicts the entry (see cache.ts).
  app.get('/insights', async (req: Request, res: Response) => {
    const days = Number(req.query.days) || null;
    try {
      res.json(await cached(req.originalUrl, () => computeInsights(days)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
