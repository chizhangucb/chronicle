import type { Express, Request, Response } from 'express';
import { resolve } from 'node:path';
import { getHubAdapter } from '../hub/adapter.ts';
import { resolveHub, isNisseHub, expandTilde } from '../hub/resolve.ts';
import { writeConfig } from '../autosync.ts';

// Hub adapter HTTP surface (CHI-323 part 1.5). Mounted under /api.
//   GET  /api/hub/status  -> { present, mode, root, reason? }  (client gates ops nav on this)
//   POST /api/hub/config  -> setup affordance: point Chronicle at a nisse hub
// Per-organ slice routes (GET /api/hub/{modules,safety,jobs,memory,codegraphs})
// land with their organs (1c-1g).
export function mountHub(app: Express): void {
  app.get('/hub/status', (_req: Request, res: Response) => {
    res.json(getHubAdapter().status());
  });

  // Modules slice (organ 1c). Absent hub -> a sentinel the client uses to hide
  // ops nav + show the Nisse upsell, never a half-answer.
  app.get('/hub/modules', (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json(adapter.modules());
  });

  // Setup affordance (D3): write hubRoot to ~/.chronicle/config.json. Writes
  // through writeConfig's MERGE ({...readConfig(), hubRoot}) so the existing
  // autosync / noise-gate config is preserved — never a fresh write, never a
  // second config file (review #1). This is a mutating route; it goes under the
  // gate token in 1b along with every other write (D2).
  app.post('/hub/config', (req: Request, res: Response) => {
    const raw = req.body?.hubRoot;

    // Clearing: empty/null hubRoot removes the key (back to env/absent).
    if (raw === null || raw === '' || raw === undefined) {
      writeConfig({ hubRoot: undefined });
      return res.json(getHubAdapter().status());
    }

    if (typeof raw !== 'string') {
      return res.status(400).json({ ok: false, error: 'hubRoot must be a string path' });
    }
    const root = resolve(expandTilde(raw.trim()));
    if (!isNisseHub(root)) {
      return res.status(400).json({
        ok: false,
        error: `${root} is not a nisse-format hub`,
        expected: ['operations.md', 'records/', 'governance/'],
      });
    }
    writeConfig({ hubRoot: root });
    // Re-resolve so the response reflects exactly what the next request will see.
    const h = resolveHub();
    res.json({ present: h.mode !== 'absent', mode: h.mode, root: h.root });
  });
}
