import type { Express, Request, Response } from 'express';
import { computeActivity } from '../activity.ts';
import { cached } from '../cache.ts';

export function mountActivity(app: Express): void {
  // Home dashboard feed (live + since-you-left rows, burn tile). Cached by full
  // request URL (encodes `since`+`days`); the generation-keyed cache (cache.ts)
  // is invalidated on every DB write, so a re-import/sync refreshes it. `since`
  // and `days` are plain query params — a missing/garbage value degrades to the
  // documented defaults inside computeActivity (trailing 12h / no window).
  app.get('/activity', (req: Request, res: Response) => {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const days = Number(req.query.days) || null;
    try {
      res.json(cached(req.originalUrl, () => computeActivity(since, days)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
