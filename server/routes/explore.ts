import type { Express, Request, Response } from 'express';
import { computeExplore, type ExploreMetric, type ExploreGroup } from '../explore.ts';
import type { Scope } from '../scope.ts';
export function mountExplore(app: Express): void {
  app.get('/explore', (req: Request, res: Response) => {
    const scope: Scope = { type: (req.query.scope as Scope['type']) || 'all', id: req.query.id as string | undefined };
    res.json(computeExplore({
      scope, days: Number(req.query.days) || null,
      metric: (req.query.metric as ExploreMetric) || 'spend',
      group: (req.query.group as ExploreGroup) || 'model',
      subgroup: (req.query.subgroup as ExploreGroup) || undefined,
      rollup: 'total', topN: Number(req.query.topN) || 10,
    }));
  });
}
