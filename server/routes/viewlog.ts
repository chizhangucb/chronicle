import type { Express, Request, Response } from 'express';
import { recordView, closeView, viewLogSummary, clearViewLog, type ViewEvent } from '../viewlog.ts';
import { readConfig, writeConfig } from '../autosync.ts';

// The view-log seam (CHI-325 3a). Three routes, all local:
//   POST   /api/view-log          record events (batched)
//   GET    /api/view-log/summary  the Settings readout
//   DELETE /api/view-log          the Settings Clear button
//
// NOTE the gate: server/api.ts mounts gateTokenGuard on EVERY non-GET, so both
// the POST and the DELETE arrive with `x-gate-token` or get a 403. The client
// side of that is free (src/api.ts `j()` attaches the token to every mutating
// method already), but a caller that hand-rolls a fetch here will 403, which
// is the intended posture, not a bug to work around.
//
// The POST carries BOTH halves of a navigation: `closes` fills in the dwell of
// the row the operator is leaving, `events` opens the row they are arriving at.
// One round trip per navigation rather than two, and the client gets the new
// row's id back so it can close that one in turn.
export function mountViewLog(app: Express): void {
  app.post('/view-log', (req: Request, res: Response) => {
    // Off by default is wrong for a log whose whole purpose is a long baseline,
    // but the operator can turn it off; when off we accept and drop, so the
    // client needs no separate status fetch before it can navigate.
    if (readConfig().viewLog === false) return res.json({ ids: [], recorded: 0, closed: 0, enabled: false });

    const ua = req.get('user-agent');

    // Close first, so a navigation's two halves land in the order they happened.
    const closesRaw: unknown = req.body?.closes;
    let closed = 0;
    for (const c of Array.isArray(closesRaw) ? closesRaw.slice(0, 20) : []) {
      if (!c || typeof c !== 'object') continue;
      const cl = c as Record<string, unknown>;
      if (typeof cl.id === 'number' && typeof cl.dwellMs === 'number' && closeView(cl.id, cl.dwellMs)) closed++;
    }

    const raw: unknown = req.body?.events;
    const ids: (number | null)[] = [];
    for (const e of Array.isArray(raw) ? raw.slice(0, 20) : []) {
      if (!e || typeof e !== 'object') { ids.push(null); continue; }
      const ev = e as Record<string, unknown>;
      ids.push(recordView(
        {
          route: typeof ev.route === 'string' ? ev.route : '',
          event: ev.event as ViewEvent,
          detail: typeof ev.detail === 'string' ? ev.detail : null,
          actorClient: typeof ev.actor === 'string' ? ev.actor : null,
          gesture: ev.gesture === true,
        },
        ua,
      ));
    }
    // Always 200. A rejected event is not a client error worth surfacing: the
    // log is best-effort and must never be able to break a navigation.
    res.json({ ids, recorded: ids.filter((i) => i !== null).length, closed, enabled: true });
  });

  app.get('/view-log/summary', (_req: Request, res: Response) => {
    try {
      res.json({ enabled: readConfig().viewLog !== false, ...viewLogSummary() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/view-log', (_req: Request, res: Response) => {
    try {
      res.json({ cleared: clearViewLog() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The on/off switch lives with the log rather than in /settings' big patch
  // handler so the whole feature is one file to read and one file to remove.
  app.patch('/view-log/settings', (req: Request, res: Response) => {
    if (typeof req.body?.viewLog !== 'boolean') return res.status(400).json({ error: 'viewLog must be a boolean' });
    const cfg = writeConfig({ viewLog: req.body.viewLog });
    res.json({ enabled: cfg.viewLog !== false });
  });
}
