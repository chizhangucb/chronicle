import type { Express, Request, Response } from 'express';
import { computeWaste } from '../waste.ts';
import { rangeOf } from '../scope.ts';
import { cached } from '../cache.ts';

export function mountWaste(app: Express): void {
  // Efficiency waste signals (cache churn / right-sizing candidates / rereads),
  // windowed by `days`. Ships token cells + counts; the client prices.
  app.get('/waste', (req: Request, res: Response) => {
    const days = Number(req.query.days) || null;
    try {
      res.json(cached(req.originalUrl, () => computeWaste({ type: 'all' }, rangeOf(days))));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
