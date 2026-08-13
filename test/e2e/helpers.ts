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

  const miniFiles = [miniAlphaId, miniBravoId, miniMinorId].map((id) => {
    const f = project.sessions?.find((s) => s.id === id)?.file;
    if (!f) throw new Error(`Mini fixture session not found in scan result: ${id}`);
    return f;
  });

  const importRes = await fetch(`${baseURL}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'claude-code', logDir: project.logDir, files: [sessionFile, ...miniFiles] }),
  });
  if (!importRes.ok) throw new Error(`Seed import failed (${importRes.status}): ${await importRes.text()}`);
  const importJson = (await importRes.json()) as ImportResponse;
  if (!importJson.imported || importJson.imported < 4) {
    throw new Error(`Seed import reported ${importJson.imported ?? 0} sessions imported, expected 4: ${JSON.stringify(importJson)}`);
  }

  return { baseURL, dataDir, fixtureDir, sessionId, miniAlphaId, miniBravoId, miniMinorId, pid: proc.pid ?? -1, proc };
}

export function stopSeeded(state: Pick<SeedState, 'pid' | 'dataDir' | 'fixtureDir'>): void {
  if (state.pid > 0) {
    try { process.kill(state.pid); } catch { /* already gone */ }
  }
  for (const dir of [state.dataDir, state.fixtureDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
