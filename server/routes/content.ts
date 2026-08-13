import type { Express, Request, Response } from 'express';
import { computeContent } from '../content.ts';
import type { Scope } from '../scope.ts';
import { cached } from '../cache.ts';

const SCOPE_TYPES: Scope['type'][] = ['all', 'project', 'session'];

export function mountContent(app: Express): void {
  // Validate `scope` before calling computeContent, and try/catch the call —
  // matches mountInsights's pattern (400 on a bad param, 500 JSON on any
  // other failure, never an unhandled exception).
  app.get('/content', (req: Request, res: Response) => {
    const scopeType = String(req.query.scope || 'all');
    if (!SCOPE_TYPES.includes(scopeType as Scope['type'])) {
      return void res.status(400).json({ error: `invalid scope: ${scopeType}` });
    }
    const scope: Scope = { type: scopeType as Scope['type'], id: req.query.id as string | undefined };
    try {
      res.json(cached(req.originalUrl, () => computeContent(scope, Number(req.query.days) || null)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
