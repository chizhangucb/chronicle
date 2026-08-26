// Playwright E2E harness: seed a temp Chronicle instance with the Task-1 big
// fixture session (120 subagents, 5000 messages — test/fixtures/gen-big-session.mjs)
// and launch the standalone server against it.
//
// Design choice (documented per the task brief's "pick the simpler" note):
// Playwright's built-in `webServer` config option only supports "poll a URL
// until it responds" as its readiness signal — it can't distinguish "the
// server is listening" from "the fixture has finished importing", and the
// import (5000 messages + 120 subagent files) takes long enough that a naive
// `webServer` setup would race: the first spec could hit an empty Home page.
// Instead, `launchSeeded()` runs to completion — build, generate fixture,
// spawn the server, wait for it to answer, seed via the import API, confirm
// the import succeeded — entirely inside Playwright's `globalSetup`, which
// is guaranteed to finish before any test starts. `globalSetup` and the test
// workers are separate processes, so the connection info is persisted to a
// JSON file (`STATE_FILE`) rather than kept in a module-scope variable; specs
// call `readSeedState()` to get it. `globalTeardown` reads the same file to
// kill the server and clean up the temp dirs.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateBigSession } from '../fixtures/gen-big-session.mjs';
import { writeMiniSession } from '../fixtures/gen-mini-session.mjs';

// Reference viewport widths the overflow smoke check runs at (spec §5.1,
// step 2d): a laptop, a common desktop, and a wide desktop.
export const WIDTHS = [1024, 1366, 1728];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// Where globalSetup persists the seeded server's connection info for specs
// (and globalTeardown) to read back.
export const STATE_FILE = path.join(os.tmpdir(), 'chronicle-e2e-state.json');

export interface SeedState {
  baseURL: string;
  dataDir: string;
  fixtureDir: string;
  sessionId: string;
  pid: number;
  // Task 14 (select.spec.ts): 3 small extra sessions seeded alongside the big
  // fixture — the big fixture is deliberately ONE session on ONE day, which
  // can't exercise day-group tri-state selection or a filtered multi-row
  // "Select all". miniAlpha/miniBravo land on the same (second) day as each
  // other — a 2-row day-group — while miniMinor is a sub-10-message session
  // on a third day that the noise gate routes into the minor-sessions bucket
  // instead of the main ledger. See gen-mini-session.mjs.
  miniAlphaId: string;
  miniBravoId: string;
  miniMinorId: string;
  // Task 7 (window-matrix): two more mini sessions, timestamped RELATIVE TO
  // Date.now() at seed time (not a fixed calendar date like the three
  // above) — see the writeMiniSession call sites below for why.
  spanningSessionId: string;
  todayOnlySessionId: string;
}

export function readSeedState(): SeedState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SeedState;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Builds the client bundle once. Skipped when dist/index.html already exists
// (fast local re-runs of `npm run test:e2e`); CI always starts from a clean
// checkout, so it always builds there.
function ensureClientBuilt(): void {
  const distIndex = path.join(REPO_ROOT, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) return;
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chronicle standalone server never became ready at ${url}: ${String(lastErr)}`);
}

interface ScannedSession {
  id: string;
  file: string | null;
}
interface ScannedProject {
  logDir: string;
  sessions?: ScannedSession[];
}
interface ScanResponse {
  'claude-code'?: ScannedProject[];
}
interface ImportResponse {
  imported?: number;
}

// Generates the fixture, starts a standalone server against a fresh temp
// CHRONICLE_DATA_DIR with CHRONICLE_E2E=1 (unlocks the `?dir=` scan/import
// override in server/routes/import-sync.ts — never live unless that env var
// is set), then seeds the DB THROUGH THE REAL IMPORT API: a guarded
// `GET /api/scan?dir=<fixtureDir>` to discover the generated session, then a
// normal `POST /api/import` with the discovered logDir/file — not a direct
// DB write. Returns only after the import is confirmed (imported >= 1), so
// callers never observe a half-seeded server.
export async function launchSeeded(): Promise<SeedState & { proc: ChildProcess }> {
  ensureClientBuilt();

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-e2e-fixture-'));
  const { sessionId } = generateBigSession(fixtureDir);

  // Task 14: 3 small extra sessions in the SAME munged project dir as the big
  // fixture (writeMiniSession defaults to the big fixture's cwd), so they
  // scan as more sessions of the one seeded project. Noon-UTC timestamps give
  // a wide margin either side of local midnight so the day-group bucketing
  // (client-side, in the browser's timezone) lands on the intended calendar
  // day regardless of the machine running the suite.
  const miniAlphaId = 'minifix-alpha';
  const miniBravoId = 'minifix-bravo';
  const miniMinorId = 'minifix-minor';
  writeMiniSession(fixtureDir, {
    sessionId: miniAlphaId, dateISO: '2026-08-05T10:00:00.000Z', turns: 8,
    promptText: 'Mini fixture Alpha: review the auth flow.',
  });
  writeMiniSession(fixtureDir, {
    sessionId: miniBravoId, dateISO: '2026-08-05T14:00:00.000Z', turns: 8,
    promptText: 'Mini fixture Bravo: investigate the billing bug.',
  });
  writeMiniSession(fixtureDir, {
    sessionId: miniMinorId, dateISO: '2026-08-06T10:00:00.000Z', turns: 2, // <10 messages -> minor
    promptText: 'Mini fixture Charlie: quick tweak.',
  });

  // Task 7 (window-matrix): the fixture above is pinned to a fixed calendar
  // date (2026-08), so it's invisible to "Today"/"7d"/"30d" windows once this
  // suite runs far enough past that date (explore.spec.ts's header comment
  // already documents this exact fragility). These two sessions are seeded
  // RELATIVE TO Date.now() AT THIS POINT (globalSetup runs once, before any
  // spec starts, so this is deterministic for the whole test run even though
  // the absolute timestamps drift run to run).
  const nowMs = Date.now();
  const spanningSessionId = 'minifix-spanning';
  const todayOnlySessionId = 'minifix-today';
  // spanningSessionId: starts 26h before now — guaranteed to fall on an
  // earlier LOCAL calendar day than "today" no matter what the wall-clock
  // time is when this runs, since the span exceeds 24h — and ends 5 minutes
  // before now, which is trivially always "today" (an end 5 minutes shy of
  // "now" cannot itself be in the future or cross back over a *later*
  // midnight). This is the exact regression shape overlapGate
  // (server/windowUsage.ts) fixes: the OLD gate compared only
  // `started_at >= cutoff` and would have dropped this session from "Today"
  // even though ~26h of its own activity ran INTO today. 30 turns (60
  // messages, well over the noise-gate's 10-message floor) spread evenly
  // across the ~26h span keeps every individual inter-message gap well under
  // durations.ts's 10-min Agent-Active cap, but the capped sum still clears
  // the 5-min-active floor by two orders of magnitude, so this is never
  // routed into the minor-sessions bucket regardless of config.
  writeMiniSession(fixtureDir, {
    sessionId: spanningSessionId,
    dateISO: new Date(nowMs - 26 * 3600 * 1000).toISOString(),
    endISO: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    turns: 30,
    promptText: 'Mini fixture Spanning: overnight investigation of the parser regression.',
  });
  // todayOnlySessionId: entirely inside the last 40 minutes, so unless this
  // suite happens to run in the first ~35 minutes after local midnight
  // (accepted low-probability risk, same class already accepted for the
  // Today-window fractional-days math elsewhere in this app) it is
  // unambiguously "today" from start to finish — a control case alongside
  // the spanning session above for window-matrix.spec.ts's overlap-gate and
  // probes.spec.ts's dense-time-axis (D12) assertions.
  writeMiniSession(fixtureDir, {
    sessionId: todayOnlySessionId,
    dateISO: new Date(nowMs - 40 * 60 * 1000).toISOString(),
    endISO: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    turns: 12,
    promptText: 'Mini fixture Today: same-day quick investigation.',
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-e2e-data-'));
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'standalone.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHRONICLE_DATA_DIR: dataDir, CHRONICLE_E2E: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`chronicle standalone server exited (${code}):\n${out}`);
  });

  await waitForServer(`${baseURL}/api/settings`, 30_000);

  const scanRes = await fetch(`${baseURL}/api/scan?dir=${encodeURIComponent(fixtureDir)}`);
  if (!scanRes.ok) throw new Error(`Seed scan failed (${scanRes.status}): ${await scanRes.text()}`);
  const scanJson = (await scanRes.json()) as ScanResponse;
  const project = (scanJson['claude-code'] ?? []).find((p) => p.sessions?.some((s) => s.id === sessionId));
  const sessionFile = project?.sessions?.find((s) => s.id === sessionId)?.file;
  if (!project || !sessionFile) {
    throw new Error(`Fixture session not found in scan result: ${JSON.stringify(scanJson)}`);
  }

  const miniFiles = [miniAlphaId, miniBravoId, miniMinorId, spanningSessionId, todayOnlySessionId].map((id) => {
    const f = project.sessions?.find((s) => s.id === id)?.file;
    if (!f) throw new Error(`Mini fixture session not found in scan result: ${id}`);
    return f;
  });

  // Writes now carry the per-boot gate token (CHI-323 D2). The browser client
  // attaches it automatically; this Node-side seed fetch must fetch it first.
  const gateToken = ((await (await fetch(`${baseURL}/api/gate/token`)).json()) as { token: string }).token;
  const importRes = await fetch(`${baseURL}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gate-token': gateToken },
    body: JSON.stringify({ source: 'claude-code', logDir: project.logDir, files: [sessionFile, ...miniFiles] }),
  });
  if (!importRes.ok) throw new Error(`Seed import failed (${importRes.status}): ${await importRes.text()}`);
  const importJson = (await importRes.json()) as ImportResponse;
  if (!importJson.imported || importJson.imported < 6) {
    throw new Error(`Seed import reported ${importJson.imported ?? 0} sessions imported, expected 6: ${JSON.stringify(importJson)}`);
  }

  return {
    baseURL, dataDir, fixtureDir, sessionId, miniAlphaId, miniBravoId, miniMinorId,
    spanningSessionId, todayOnlySessionId, pid: proc.pid ?? -1, proc,
  };
}

export function stopSeeded(state: Pick<SeedState, 'pid' | 'dataDir' | 'fixtureDir'>): void {
  if (state.pid > 0) {
    try { process.kill(state.pid); } catch { /* already gone */ }
  }
  for (const dir of [state.dataDir, state.fixtureDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
