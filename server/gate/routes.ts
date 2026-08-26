import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { Gate, GateError, type HubApply, type Proposal } from './core.ts';
import { SURFACES } from './surfaces.ts';
import { sqliteAuditStore } from './audit-store.ts';
import { launchdAction, listJobs } from './launchd.ts';
import { viewOf } from './validate.ts';
import { resolveHub } from '../hub/resolve.ts';

/**
 * Gate transport (ported from Varde, CHI-323 part 2): express routes on the
 * console server. Transport only; every gate decision (validate, TTL, backup,
 * verify, audit) lives in core.ts.
 *
 * Endpoints (mounted under /api):
 *   GET  /api/gate/token     per-boot token
 *   GET  /api/gate/surfaces  registry with resolved availability
 *   GET  /api/gate/surface?id=<id>  browser-safe view of the target
 *   GET  /api/gate/jobs      launchd jobs with live state
 *   GET  /api/gate/audit     recent audit rows
 *   POST /api/gate/propose   {surface, change, reason} -> confirm card payload
 *   POST /api/gate/confirm   {id, decision: "confirm"|"deny", code?}
 *   POST /api/gate/apply     one-shot write, allow-mode surfaces only
 */

function dataDir(): string {
  return process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');
}

/**
 * Hub-script runner: shells out to the hub's apply_edit.py (the satellite never
 * opens a hub file for write). Undefined without a live hub (port fix (a): the
 * script is resolved under the ADAPTER's root, not Varde's env fallback), which
 * renders the hub surfaces disabled with the reason.
 */
function makeHubApply(): HubApply | undefined {
  const hub = resolveHub();
  if (hub.mode !== 'live' || !hub.root) return undefined;
  const script = join(hub.root, 'scripts', 'egress_gate', 'apply_edit.py');
  if (!existsSync(script)) return undefined;
  return (payload) => {
    const r = spawnSync('python3', [script], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    try {
      return JSON.parse(r.stdout || '{}');
    } catch {
      return {
        ok: false,
        error: `apply_edit.py produced no parseable result (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`,
        fix: 'run the script by hand to see the failure',
      };
    }
  };
}

/** Tier 2 second channel: hermes send to Telegram. A failed send is a loud
 * propose error in core.ts, never a silent no-op. */
function hermesSend(message: string): { ok: boolean; reason?: string } {
  const r = spawnSync('hermes', ['send', '--to', 'telegram', '--quiet', message], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (r.error) {
    return { ok: false, reason: `hermes send failed to launch: ${r.error.message}. Is hermes on PATH?` };
  }
  if (r.status !== 0) {
    return { ok: false, reason: `hermes send exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` };
  }
  return { ok: true };
}

/** The console's gate: the shipped surface registry, audit in the gate_audit
 * table, backups in the app home, hub root fed from the adapter, launchd action
 * on macOS only. */
export function makeConsoleGate(): Gate {
  const hub = resolveHub();
  return new Gate({
    repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
    audit: sqliteAuditStore(),
    backupDir: join(dataDir(), 'gate-backups'),
    surfaces: SURFACES,
    demo: hub.mode === 'demo', // inert for writes in demo (never touches real machine state)
    hubRoot: hub.mode === 'live' && hub.root ? hub.root : undefined,
    // launchd is macOS-only; elsewhere the surface renders disabled with the
    // reason (graceful degradation, never a hidden failure).
    actions: process.platform === 'darwin' ? { 'launchd-jobs': launchdAction } : {},
    hubApply: makeHubApply(),
    secondChannelSend: hermesSend,
  });
}

/** What the browser may see of a proposal: never the second-factor code, never
 * full file bodies (config.yaml can hold provider keys). */
function publicProposal(p: Proposal) {
  return {
    id: p.id,
    surfaceId: p.surfaceId,
    reason: p.reason,
    diff: p.diff,
    requiresCode: p.requiresCode ?? false,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}

/**
 * Global write guard (CHI-323 D2): every MUTATING request must carry the
 * per-boot token from GET /api/gate/token. One consistent posture over EVERY
 * write, the ported gate routes AND Chronicle's existing writes, no split.
 * GET/HEAD/OPTIONS are exempt (the token GET is itself a GET). Same-origin/CSRF
 * guard, not auth: a hostile page can POST at 127.0.0.1 but cannot read the
 * token GET, so its POST dies here.
 */
export function gateTokenGuard(gate: Gate): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.headers['x-gate-token'] !== gate.token) {
      res.status(403).json({ error: 'bad token', fix: 'reload the console to pick up the new per-boot token' });
      return;
    }
    next();
  };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof GateError) {
    res.status(err.status).json({ error: err.message, fix: err.fix });
  } else {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), fix: 'see the console-server log' });
  }
}

export function mountGateRoutes(app: Express, gate: Gate): void {
  const guard = (needsToken: boolean, handler: (req: Request, res: Response) => void) =>
    (req: Request, res: Response) => {
      if (needsToken && req.headers['x-gate-token'] !== gate.token) {
        res.status(403).json({ error: 'bad token', fix: 'reload the console to pick up the new per-boot token' });
        return;
      }
      gate.sweepExpired();
      try {
        handler(req, res);
      } catch (err) {
        sendError(res, err);
      }
    };

  app.get('/gate/token', guard(false, (_req, res) => {
    res.json({ token: gate.token });
  }));

  app.get('/gate/surfaces', guard(false, (_req, res) => {
    res.json({ surfaces: gate.listSurfaces() });
  }));

  app.get('/gate/surface', guard(false, (req, res) => {
    const id = String(req.query.id ?? '');
    const { surface, text } = gate.readSurface(id);
    res.json({ surface, text: viewOf(surface.schema, text) });
  }));

  app.get('/gate/jobs', guard(false, (_req, res) => {
    if (process.platform !== 'darwin') {
      res.json({ jobs: [], reason: 'launchd jobs are macOS-only' });
      return;
    }
    res.json({ jobs: listJobs() });
  }));

  app.get('/gate/audit', guard(false, (_req, res) => {
    res.json({ rows: gate.readAudit() });
  }));

  app.post('/gate/propose', guard(true, (req, res) => {
    const body = req.body ?? {};
    const proposal = gate.propose(String(body.surface ?? ''), body.change, String(body.reason ?? ''));
    res.json({ proposal: publicProposal(proposal) });
  }));

  // One-shot write for allow-mode surfaces (the UI click is the intent, no
  // card); core.ts refuses confirm-mode surfaces here.
  app.post('/gate/apply', guard(true, (req, res) => {
    const body = req.body ?? {};
    const result = gate.apply(String(body.surface ?? ''), body.change, String(body.reason ?? ''));
    res.json({ ok: true, ...result });
  }));

  app.post('/gate/confirm', guard(true, (req, res) => {
    const body = req.body ?? {};
    const id = String(body.id ?? '');
    if (body.decision === 'deny') {
      gate.deny(id);
      res.json({ denied: true });
      return;
    }
    if (body.decision !== 'confirm') {
      throw new GateError(400, 'decision must be "confirm" or "deny"', 'send a valid decision');
    }
    const result = gate.confirm(id, 'operator', typeof body.code === 'string' ? body.code : undefined);
    res.json({ ok: true, ...result });
  }));
}
