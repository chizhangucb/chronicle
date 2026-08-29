import type { Express, Request, Response } from 'express';
import { computeRoster } from '../routing.ts';
import { cached } from '../cache.ts';

export function mountRouting(app: Express): void {
  // Routing-compliance roster (hub governance/model-routing.md families).
  // Hub-conditional; the client classifies + prices from /api/insights.
  app.get('/routing', (_req: Request, res: Response) => {
    try {
      res.json(cached('/routing', () => computeRoster()));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
