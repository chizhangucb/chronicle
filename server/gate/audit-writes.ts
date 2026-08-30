import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Gate } from './core.ts';

/**
 * CHI-396: put Chronicle's OWN writes in the write log.
 *
 * The gate audits the seven surfaces it owns. Every other mutating route
 * (settings, sessions, projects, security rules, hub config, imports) wrote
 * with no record at all: `Gate.auditAllowed` existed for exactly this and had
 * no caller. The most conspicuous gap was `DELETE /sessions/:id/source-file`,
 * which unlinks a real transcript off disk and left no trace.
 *
 * Middleware rather than ~25 call sites: one place cannot miss a route, and it
 * keeps covering routes added later. The cost is coarser detail (a route and a
 * status, not a semantic diff), which is the right trade for a log whose job is
 * "what has this app changed".
 *
 * Three rules, all deliberate:
 *
 * 1. NEVER log a request body. Bodies carry settings values, redaction-rule
 *    patterns, and search text. The log records that a write happened and where,
 *    never its content. Route params are kept (a session id identifies the
 *    target and is already in the URL); the query string is dropped.
 * 2. Only log writes that HAPPENED. A 4xx is a rejected request, not a change,
 *    and logging those turns the write log into an error log. 2xx audits as
 *    "allowed"; 5xx audits as "failed", because a write that blew up halfway is
 *    exactly what someone reads this log to find.
 * 3. Skip the routes that would drown it. `POST /view-log` fires on every
 *    navigation and IS a log, so auditing it is both circular and enormous.
 *    Clearing it and changing its settings are real state changes and stay.
 */

/** Paths whose writes are not state changes worth a row. Matched on the
 * pathname, method-scoped. */
const SKIP: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/view-log' },   // one per navigation; it is itself a log
  { method: 'POST', path: '/demo/start' }, // demo lifecycle, not operator state
  { method: 'POST', path: '/demo/exit' },
];

/** Collapse ids out of a path so the log groups by ROUTE, not by target:
 * `/sessions/abc123/promote` -> `/sessions/:id/promote`. Express fills
 * `req.route` only after routing, which has happened by the time `finish`
 * fires; this is the fallback when it has not (a 404 never matched a route). */
function routeLabel(req: Request): string {
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const routed = (req as Request & { route?: { path?: string } }).route?.path;
  if (routed) return `${base}${routed}`;
  return `${base}${req.path}`.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id');
}

export function auditWrites(gate: Gate): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    // The gate's own routes write their own, richer rows (with the diff).
    if (req.path.startsWith('/gate/')) return next();
    if (SKIP.some((s) => s.method === req.method && s.path === req.path)) return next();

    res.on('finish', () => {
      if (res.statusCode < 200 || (res.statusCode >= 300 && res.statusCode < 500)) return;
      try {
        gate.auditAllowed(
          `${req.method} ${routeLabel(req)}`,
          {
            method: req.method,
            route: routeLabel(req),
            status: res.statusCode,
            // params only: named route values, never the body or query string
            ...(req.params && Object.keys(req.params).length ? { params: req.params } : {}),
          },
          res.statusCode >= 500 ? 'failed' : 'allowed',
        );
      } catch {
        // A log must never take down the write it is describing. The response
        // has already been sent by the time this runs, so a throw here would
        // surface as an unhandled rejection and nothing else.
      }
    });
    next();
  };
}
