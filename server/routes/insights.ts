import type { Express, Request, Response } from 'express';
import { computeInsights } from '../insights.ts';

export function mountInsights(app: Express): void {
  app.get('/insights', (req: Request, res: Response) => {
    const days = Number(req.query.days) || null;
    res.json(computeInsights(days));
  });
}
