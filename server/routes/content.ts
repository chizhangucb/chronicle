import type { Express, Request, Response } from 'express';
import { computeContent } from '../content.ts';
import type { Scope } from '../scope.ts';
export function mountContent(app: Express): void {
  app.get('/content', (req: Request, res: Response) => {
    const scope: Scope = { type: (req.query.scope as Scope['type']) || 'all', id: req.query.id as string | undefined };
    res.json(computeContent(scope, Number(req.query.days) || null));
  });
}
