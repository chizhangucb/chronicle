import type { Express, Request, Response } from 'express';
import { resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getHubAdapter } from '../hub/adapter.ts';
import { resolveHub, isNisseHub, expandTilde } from '../hub/resolve.ts';
import { confidentialMarkersEnabled } from '../hub/slices/confidential.ts';
import { buildLaunchCommand, gapReviewPrompt } from '../launch.ts';
import { jobLogView } from '../job-logs.ts';
import { readConfig, writeConfig } from '../autosync.ts';
import type { MemoryScopePatterns } from '../hub/slices/memoryscope.ts';

// Hub adapter HTTP surface (CHI-323 part 1.5). Mounted under /api.
//   GET  /api/hub/status  -> { present, mode, root, reason? }  (client gates ops nav on this)
//   POST /api/hub/config  -> setup affordance: point Chronicle at a nisse hub
// Per-organ slice routes (GET /api/hub/{modules,safety,jobs,memory,codegraphs})
// land with their organs (1c-1g).

// Memory scope-suggest (CHI-339, the disclosed 1g fast-follow): single-flight
// in-memory state, no persistent file — the suggestion is ephemeral until the
// client turns it into a gate proposal via the EXISTING /api/gate/propose
// (src/gate/gate.ts's gatePropose). This route never writes anything itself.
interface ScopeSuggestState {
  running: boolean;
  suggestion: MemoryScopePatterns | null;
  error: string | null;
}
declare global {
  // eslint-disable-next-line no-var
  var __chronicleScopeSuggest: ScopeSuggestState | undefined;
}
const scopeSuggestState: ScopeSuggestState = (globalThis.__chronicleScopeSuggest ??= { running: false, suggestion: null, error: null });

/** Runner entry: the compiled JS in the published package, else the TS source in
 * dev (Node 24 type-strips it). Same resolution shape as briefing's runnerEntry. */
function scopeSuggestRunnerEntry(): string | null {
  const candidates = [
    new URL('../../scripts/run-scope-suggest.js', import.meta.url), // dist-server/scripts/run-scope-suggest.js
    new URL('../../scripts/run-scope-suggest.ts', import.meta.url), // dev: scripts/run-scope-suggest.ts
  ].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? null;
}

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

  // Jobs slice (organ 1e): launchd + cron + hub registry + repo templates, with
  // live state. Absent hub -> sentinel (page hidden).
  app.get('/hub/jobs', (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json(adapter.jobs());
  });

  // Records (CHI-324 2h): the append-only hub records (decisions + session
  // ledger), index fields only. Absent-gated like every ops slice.
  app.get('/hub/records', (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json(adapter.records());
  });

  // Job log tail (organ 1e): the browser sends a job ID, never a path. Only the
  // log paths the jobs slice itself declares for that job are opened (last 100
  // lines, tail-capped).
  app.get('/jobs/log', (req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    const id = String(req.query.id ?? '');
    const view = jobLogView(adapter.jobs().jobs, id);
    if (!view) return res.status(404).json({ error: `unknown job "${id}"`, fix: 'reload the Jobs page' });
    res.json(view);
  });

  // Memory graph (organ 1g). HEAVY slice, freshness-cached in the adapter. Emits
  // titles/paths only, prunes confidential/next-ventures (never body text).
  app.get('/hub/memory', async (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json(await adapter.memoryGraph());
  });

  // Memory SUMMARY (CHI-325 3d). The status band on / needs four numbers, and
  // GET /hub/memory ships the entire graph (every node, link and noteDate) to
  // get them: the demo file alone is 34KB and a live hub is far larger. Sending
  // that to the DEFAULT route on every load would be a real regression, so the
  // band reads this instead. The adapter's own freshness cache still does the
  // expensive work at most once per TTL, shared with the /memory page.
  app.get('/hub/memory/summary', async (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    const slice = await adapter.memoryGraph();
    res.json({
      hubPresent: true,
      totalNotes: slice.stats.totalNotes,
      totalLinks: slice.stats.totalLinks,
      stale: slice.stats.stale,
      freshness: slice.stats.freshness,
      // Growth over the recent window, used as the band's glyph. A sparkline of
      // note count is a cheap, honest stand-in for Varde's graph thumbnail,
      // which is what forced the heavy payload in the first place.
      growth: (slice.growth?.series ?? []).slice(-14).map((d) => d.total ?? 0),
    });
  });

  // Memory scope-suggest (CHI-339): kicks the headless runner (structure NAMES
  // only, no file reads) and holds its parsed proposal for the ScopePanel,
  // which renders it as a normal gate diff. Guard order: hub-absent (409, the
  // demo check alone is not enough — resolveHub() can also return mode:
  // 'absent'), demo (409, matches /open-file + /launch/gap), already running
  // (409, single-flight — matches briefing's "run already in progress" style).
  app.post('/memory/scope-suggest', (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    const st = adapter.status();
    if (!st.present) return res.status(409).json({ error: 'no hub connected', fix: 'set a hub first' });
    if (st.mode === 'demo') return res.status(409).json({ error: 'demo seed, scope suggest disabled', fix: 'run on a real console with a hub' });
    if (scopeSuggestState.running) return res.status(409).json({ error: 'a scope-suggest run is already in progress' });
    const entry = scopeSuggestRunnerEntry();
    if (!entry) return res.status(500).json({ error: 'scope-suggest runner not found', fix: 'reinstall Chronicle' });
    scopeSuggestState.running = true;
    scopeSuggestState.suggestion = null;
    scopeSuggestState.error = null;
    let out = '';
    let errOut = '';
    const child = spawn(process.execPath, [entry], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { errOut += chunk; });
    const settle = (code: number): void => {
      scopeSuggestState.running = false;
      if (code === 0) {
        try { scopeSuggestState.suggestion = JSON.parse(out); }
        catch { scopeSuggestState.error = 'suggest run produced unparseable output'; }
      } else {
        scopeSuggestState.error = errOut.trim().slice(0, 400) || `suggest run exited ${code}`;
      }
    };
    child.on('exit', (code) => settle(code ?? 1));
    child.on('error', () => settle(1));
    res.json({ started: true });
  });

  app.get('/memory/scope-suggest/status', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json(scopeSuggestState);
  });

  // Open a memory note in the operator's editor (organ 1g). Bounded HARD: only a
  // .md file that resolves UNDER the live hub root, never a confidential/next-
  // ventures segment. Mutating (opens an app) -> rides the gate token. Demo-refused.
  app.post('/open-file', (req: Request, res: Response) => {
    const h = resolveHub();
    if (h.mode === 'demo') return res.status(409).json({ ok: false, error: 'demo seed, open-file disabled' });
    if (!h.root) return res.status(409).json({ ok: false, error: 'no hub connected' });
    const rel = String(req.body?.path ?? '');
    const abs = resolve(h.root, rel);
    if (!abs.startsWith(h.root + sep) || !abs.endsWith('.md')) {
      return res.status(400).json({ ok: false, error: 'path must be a .md file inside the hub' });
    }
    if (abs.split(sep).some((seg) => seg === 'confidential' || seg === 'next-ventures')) {
      return res.status(403).json({ ok: false, error: 'refusing to open a confidential path' });
    }
    if (process.platform !== 'darwin') return res.json({ ok: false, error: 'open is macOS-only', opened: abs });
    const r = spawnSync('open', [abs], { encoding: 'utf-8', timeout: 10_000 });
    if (r.status !== 0) return res.json({ ok: false, error: (r.stderr || '').trim() || 'open failed', opened: abs });
    res.json({ ok: true, opened: abs });
  });

  // Built code graphs (organ 1g): graphs/index.json + per-graph god-nodes.
  app.get('/hub/codegraphs', async (_req: Request, res: Response) => {
    const adapter = getHubAdapter();
    if (!adapter.status().present) return res.json({ hubPresent: false });
    res.json({ graphs: await adapter.codegraphs() });
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
