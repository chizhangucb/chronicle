import type { Express, Request, Response } from 'express';
import { computeDetectors } from '../detectors.ts';
import { cached } from '../cache.ts';

export function mountDetectors(app: Express): void {
  // Efficiency detector counts (jumbo / long-context / cache-hit inputs),
  // windowed by `days`. Cached by full URL; invalidated on every DB write.
  app.get('/detectors', (req: Request, res: Response) => {
    const days = Number(req.query.days) || null;
    try {
      res.json(cached(req.originalUrl, () => computeDetectors(days)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
