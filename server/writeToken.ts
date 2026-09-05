import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Same-origin guard for mutating routes (CHI-222).
 *
 * Chronicle serves an unauthenticated HTTP API on loopback. Any page the user
 * has open can fire a cross-origin POST at 127.0.0.1, but it cannot READ a
 * cross-origin response, so it cannot learn the per-boot token that this guard
 * demands. That is the whole mechanism: a CSRF guard, not auth. Nothing here
 * protects against a process already on this machine.
 *
 * One token per boot, minted here and handed out by `GET /api/write-token`.
 * It lives on globalThis so a Vite SSR reload does not remint mid-session and
 * 403 an open tab (same pattern as server/cache.ts / server/autosync.ts).
 */
declare global {
  // eslint-disable-next-line no-var
  var __chronicleWriteToken: string | undefined;
}

export const writeToken: string = (globalThis.__chronicleWriteToken ??= randomUUID());

export const WRITE_TOKEN_HEADER = 'x-chronicle-write-token';

/** Every non-GET request must carry the per-boot token. GET/HEAD/OPTIONS are
 * exempt, which is what lets the token route itself answer. */
export function writeTokenGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.headers[WRITE_TOKEN_HEADER] !== writeToken) {
      res.status(403).json({ error: 'bad token', fix: 'reload the app to pick up the new per-boot token' });
      return;
    }
    next();
  };
}

export function mountWriteToken(app: Express): void {
  app.get('/write-token', (_req: Request, res: Response) => {
    res.json({ token: writeToken });
  });
}
