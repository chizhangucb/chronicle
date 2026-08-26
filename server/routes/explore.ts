import type { Express, Request, Response } from 'express';
import { computeExplore, type ExploreMetric, type ExploreGroup, type ExploreRollup } from '../explore.ts';
import type { Scope } from '../scope.ts';
import { cached } from '../cache.ts';

const SCOPE_TYPES: Scope['type'][] = ['all', 'project', 'session'];
const METRICS: ExploreMetric[] = ['spend', 'tokens', 'requests', 'active', 'sessions', 'errors'];
const GROUPS: ExploreGroup[] = ['model', 'project', 'source', 'tool', 'skill', 'subagent', 'hour', 'session', 'mcp', 'provider'];
const ROLLUPS: ExploreRollup[] = ['total', 'hourly', 'daily', 'weekly', 'monthly'];

export function mountExplore(app: Express): void {
  // Validate query params against their allowed value sets BEFORE calling
  // computeExplore — group/subgroup feed groupExpr's/errorGroupCol's switch,
  // whose `default` throws on anything outside ExploreGroup; without this
  // guard an unrecognized `?group=` would still reach that throw and surface
  // as an unhandled-looking 500 rather than a clean 400. try/catch below is
  // defense in depth for any other failure (matches mountInsights's pattern).
  app.get('/explore', (req: Request, res: Response) => {
    const scopeType = String(req.query.scope || 'all');
    const metric = String(req.query.metric || 'spend');
    const group = String(req.query.group || 'model');
    const subgroupRaw = req.query.subgroup != null ? String(req.query.subgroup) : undefined;
    const rollup = String(req.query.rollup || 'total');

    if (!SCOPE_TYPES.includes(scopeType as Scope['type'])) {
      return void res.status(400).json({ error: `invalid scope: ${scopeType}` });
    }
    if (!METRICS.includes(metric as ExploreMetric)) {
      return void res.status(400).json({ error: `invalid metric: ${metric}` });
    }
    if (!GROUPS.includes(group as ExploreGroup)) {
      return void res.status(400).json({ error: `invalid group: ${group}` });
    }
    if (subgroupRaw != null && !GROUPS.includes(subgroupRaw as ExploreGroup)) {
      return void res.status(400).json({ error: `invalid subgroup: ${subgroupRaw}` });
    }
    if (!ROLLUPS.includes(rollup as ExploreRollup)) {
      return void res.status(400).json({ error: `invalid rollup: ${rollup}` });
    }

    const scope: Scope = { type: scopeType as Scope['type'], id: req.query.id as string | undefined };
    try {
      res.json(cached(req.originalUrl, () => computeExplore({
        scope, days: Number(req.query.days) || null,
        metric: metric as ExploreMetric,
        group: group as ExploreGroup,
        subgroup: (subgroupRaw as ExploreGroup) || undefined,
        rollup: rollup as ExploreRollup, topN: Number(req.query.topN) || 10,
      })));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
