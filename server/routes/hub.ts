import type { Express, Request, Response } from 'express';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getHubAdapter } from '../hub/adapter.ts';
import { resolveHub, isNisseHub, expandTilde } from '../hub/resolve.ts';
import { confidentialMarkersEnabled } from '../hub/slices/confidential.ts';
import { buildLaunchCommand, gapReviewPrompt } from '../launch.ts';
import { readConfig, writeConfig } from '../autosync.ts';

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

  // Safety posture (organ 1d): egress-gate config (emit-allowlisted, markers as
  // COUNTS), the accepted-gaps register, and the egress on/off state. No body
  // text, no marker phrases, no secrets.
  app.get('/hub/safety', (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json({ safetyNet: adapter.safetyNet(), gaps: adapter.safetyGaps(), egress: adapter.egress() });
  });

  // Confidential marker drill-down (organ 1d) — HARD-GATED (D8): a live hub AND
  // an explicit opt-in flag (env CHRONICLE_CONFIDENTIAL_MARKERS=1 or config
  // confidentialMarkers:true). The default/public build returns 403, so no
  // confidential content ever leaves an endpoint.
  app.get('/hub/safety/confidential', (_req: Request, res: Response) => {
    const h = resolveHub();
    const flag = readConfig().confidentialMarkers;
    if (!confidentialMarkersEnabled(h.mode, process.env, typeof flag === 'boolean' ? flag : undefined)) {
      return res.status(403).json({
        error: 'confidential marker drill-down is not enabled',
        fix: 'opt in with confidentialMarkers:true in ~/.chronicle/config.json on a live hub',
      });
    }
    res.json(getHubAdapter().confidentialMarkers());
  });

  // "Work on this" gap launcher (organ 1d): types `claude "<review prompt>"`
  // onto the operator's Terminal command line, UNSUBMITTED (print -z), never
  // running it. Prompt is built server-side from the register (browser sends an
  // id only). Demo-refused; non-darwin falls back to a clipboard prompt. This is
  // a mutating action, so it rides the gate token like every write (D2).
  app.post('/launch/gap', (req: Request, res: Response) => {
    const adapter = getHubAdapter();
    const st = adapter.status();
    if (st.mode === 'demo') {
      return res.status(409).json({ error: 'demo seed, launch disabled', fix: 'copy the review prompt and run it on a real console' });
    }
    if (!st.present) return res.status(409).json({ error: 'no hub connected', fix: 'set a hub first' });
    const id = String(req.body?.id ?? '');
    const gaps = adapter.safetyGaps();
    const gap = [...gaps.actionable, ...gaps.watch].find((g) => g.id === id);
    if (!gap) return res.status(404).json({ error: `unknown gap "${id}"`, fix: 'reload the Safety page' });
    const prompt = gapReviewPrompt(gap, gap.kind === 'watch');
    if (process.platform !== 'darwin') {
      return res.json({ launched: false, copyPrompt: prompt, reason: 'Terminal launch is macOS-only; copy the prompt instead' });
    }
    const cmd = buildLaunchCommand(prompt, resolveHub().root ?? undefined);
    const r = spawnSync('osascript', cmd.osascriptArgs, { encoding: 'utf-8', timeout: 15_000 });
    if (r.status !== 0) {
      return res.json({ launched: false, copyPrompt: prompt, reason: (r.stderr || '').trim() || 'osascript failed' });
    }
    res.json({ launched: true, buffer: cmd.buffer });
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
