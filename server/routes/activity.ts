import type { Express, Request, Response } from 'express';
import { computeActivity } from '../activity.ts';
import { liveWatcherSessionIds } from '../live.ts';
import { rangeOf } from '../scope.ts';
import { cached } from '../cache.ts';

// `opts.now` pins the wall clock the burn/window math reads; omitted in
// production (real Date.now()), a test passes a fixed instant so it is not
// coupled to the real time of day.
export function mountActivity(app: Express, opts: { now?: number } = {}): void {
  // Home dashboard feed (live + since-you-left rows, burn tile). Cached by full
  // request URL (encodes `since`+`days`); the generation-keyed cache (cache.ts)
  // is invalidated on every DB write, so a re-import/sync refreshes it. `since`
  // and `days` are plain query params — a missing/garbage value degrades to the
  // documented defaults inside computeActivity (trailing 12h / no window).
  //
  // The open live streams go in the key, not just the URL (#369). A session is
  // live while a client holds an SSE stream on it, and opening or closing that
  // stream is not a DB write, so the generation counter never moves for it —
  // the one input to this response that invalidation cannot see. Keying on the
  // watcher set makes the key rotate exactly when the answer does, which is the
  // rotating-key case cache.ts already prunes for. It is one Set read of a map
  // that holds 0-1 entries on a normal install.
  app.get('/activity', (req: Request, res: Response) => {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const days = Number(req.query.days) || null;
    const watching = [...liveWatcherSessionIds()].sort().join(',');
    try {
      res.json(cached(
        // A newline cannot appear in a request line, so it separates the two halves unambiguously.
        `${req.originalUrl}\nlive:${watching}`,
        () => computeActivity({ type: 'all' }, rangeOf(days, opts.now), since),
      ));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
