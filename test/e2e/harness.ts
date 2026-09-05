// The e2e harness's two primitives, kept deliberately separate (CHI #243):
//
//   seedDataDir()   produce a Chronicle data directory with the big fixture
//                   (+ the mini sessions) already imported into it
//   launchServer()  run a standalone server against SOME data directory
//
// `launchSeeded()` in helpers.ts is just the composition of the two. Keeping
// them apart is what lets global-setup provision one instance per Playwright
// worker: each worker gets its own seeded directory and its own server, keyed
// by worker index, with no fixed shared path.
//
// Seeding goes THROUGH THE REAL IMPORT API — a guarded
// `GET /api/scan?dir=<fixtureDir>` (the `?dir=` override in
// server/routes/import-sync.ts is only live under CHRONICLE_E2E=1) then a
// normal `POST /api/import` — not a direct DB write. That needs a live
// server, so `seedDataDir()` launches a throwaway one, imports, and stops it;
// the returned directory is then a plain seeded data dir that any later
// server can be pointed at.
//
// Every server this file spawns writes a RECORD: a JSON file naming its pid,
// baseURL and data dir, plus a sibling `.log` holding its stdout+stderr. Both
// are on disk rather than in memory because the process that reads them is
// almost never the process that spawned the server: global-setup runs in
// Playwright's runner process, while the specs that need the diagnosis run in
// separate worker processes that never saw the spawn. With the record on
// disk, `describeDeadServers()` can report a dead server's exit status and
// last output to a failing spec instead of a bare connection error.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateBigSession } from '../fixtures/gen-big-session.mjs';
import { writeMiniSession } from '../fixtures/gen-mini-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// Root for everything the harness persists across processes.
//
// CHI #244: this used to be ONE fixed directory, shared by every suite run on
// the machine. Two runs at once — two worktrees, two agent sessions — then
// destroyed each other: the second run's globalSetup killed the first run's
// servers and deleted its state files, and the first run's globalTeardown did
// the same back. That is the "seeded server dies mid-run" cascade: a crash
// point that moves with the overlap, connection errors in unrelated specs,
// and every one of them passing in isolation. CI never saw it because a CI
// job is the only run on its runner.
//
// So the fixed path is only the ROOT. Each run gets its own directory under
// it, created once by globalSetup and published to the worker processes
// through CHRONICLE_E2E_RUN_DIR — workers are forked after globalSetup, so
// they inherit it. Nothing outside a run's own directory is ever touched,
// except the stale sweep, which reaps only runs whose owner process is gone.
export const RUNS_ROOT = path.join(os.tmpdir(), 'chronicle-e2e');
const RUN_DIR_ENV = 'CHRONICLE_E2E_RUN_DIR';

/** This run's state directory. Throws rather than inventing one: a caller
 * without it is a process that was not started by our globalSetup, and
 * guessing a path is exactly the bug above. */
export function currentRunDir(): string {
  const dir = process.env[RUN_DIR_ENV];
  if (!dir) {
    throw new Error(
      `${RUN_DIR_ENV} is not set: the e2e harness state directory is created by globalSetup ` +
      'and inherited by worker processes. Run the suite through `npm run test:e2e`.',
    );
  }
  return dir;
}

/** Create this run's own state directory and publish it to everything forked
 * from here. Stamped with the owner pid so the stale sweep can tell an
 * abandoned run from a live one. */
export function createRunDir(): string {
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(RUNS_ROOT, 'run-'));
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }));
  adoptRunDir(dir);
  return dir;
}

/** Point this process at an existing run directory. */
export function adoptRunDir(dir: string): void {
  process.env[RUN_DIR_ENV] = dir;
}

/** Run directories left behind by a run whose owner process is no longer
 * alive — an interrupted suite whose teardown never got to run. A run whose
 * owner is still alive is NEVER stale, however old it looks. */
export function staleRunDirs(): string[] {
  let names: string[];
  try { names = fs.readdirSync(RUNS_ROOT); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith('run-')) continue;
    const dir = path.join(RUNS_ROOT, name);
    let owner: { pid?: number };
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as { pid?: number };
    } catch {
      // No readable stamp: either mid-creation by a run that is about to
      // write it, or debris. Leave it alone rather than risk the former.
      continue;
    }
    if (!isAlive(owner.pid ?? -1)) out.push(dir);
  }
  return out;
}

function recordsDir(): string {
  return path.join(currentRunDir(), 'servers');
}

export function workerStateFile(workerIndex: number): string {
  return path.join(currentRunDir(), `worker-${workerIndex}.json`);
}

/** Persisted description of one spawned server. Survives the process that
 * spawned it — `exitCode`/`exitSignal` are filled in by whoever is still
 * watching; `isAlive()` re-checks the pid for readers who were not. */
export interface ServerRecord {
  label: string;
  pid: number;
  baseURL: string;
  dataDir: string;
  logFile: string;
  exitCode?: number | null;
  exitSignal?: string | null;
}

export interface ServerHandle extends ServerRecord {
  proc: ChildProcess;
}

export interface SeededData {
  dataDir: string;
  fixtureDir: string;
  sessionId: string;
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
export function ensureClientBuilt(): void {
  const distIndex = path.join(REPO_ROOT, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) return;
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function waitForServer(url: string, timeoutMs: number, label: string): Promise<void> {
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
  throw new Error(
    `Chronicle standalone server never became ready at ${url}: ${String(lastErr)}\n${describeServer(label) ?? ''}`,
  );
}

function recordFile(label: string): string {
  return path.join(recordsDir(), `${label}.json`);
}

function writeRecord(rec: ServerRecord): void {
  fs.mkdirSync(recordsDir(), { recursive: true });
  fs.writeFileSync(recordFile(rec.label), JSON.stringify(rec));
}

export function readRecords(): ServerRecord[] {
  let names: string[];
  try { names = fs.readdirSync(recordsDir()); } catch { return []; }
  const out: ServerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(recordsDir(), name), 'utf8')) as ServerRecord); } catch { /* mid-write */ }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tailLog(logFile: string, maxChars = 4000): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return '';
  }
}

/** Human-readable status + last output for one recorded server, or null when
 * there is no such record. */
export function describeServer(label: string): string | null {
  const rec = readRecords().find((r) => r.label === label);
  if (!rec) return null;
  return formatRecord(rec);
}

function formatRecord(rec: ServerRecord): string {
  const alive = isAlive(rec.pid);
  const status = alive
    ? 'running'
    : rec.exitSignal
      ? `exited on signal ${rec.exitSignal}`
      : rec.exitCode !== undefined && rec.exitCode !== null
        ? `exited with code ${rec.exitCode}`
        : 'not running (exit status unobserved — the process that spawned it is gone)';
  const out = tailLog(rec.logFile);
  return [
    `server "${rec.label}" (pid ${rec.pid}, ${rec.baseURL}): ${status}`,
    out ? `last output:\n${out}` : 'last output: (none)',
  ].join('\n');
}

/** Status of every recorded server that is NOT currently running. Empty
 * string when they are all healthy, so a passing run stays silent. */
export function describeDeadServers(): string {
  const dead = readRecords().filter((r) => !isAlive(r.pid));
  if (dead.length === 0) return '';
  return dead.map(formatRecord).join('\n\n');
}

export interface LaunchOptions {
  dataDir: string;
  /** Distinct per server; names its record and log file. */
  label: string;
  demo?: boolean;
}

/** Spawn a standalone server against an existing data directory and wait for
 * it to answer. Does no seeding of its own. */
export async function launchServer(opts: LaunchOptions): Promise<ServerHandle> {
  ensureClientBuilt();
  const { dataDir, label, demo = false } = opts;
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  fs.mkdirSync(recordsDir(), { recursive: true });
  const logFile = path.join(recordsDir(), `${label}.log`);
  // The child's own fd, not a piped stream read by this process: the log is
  // then readable from the worker processes, which never saw the spawn, and
  // keeps filling regardless of what happens to this process.
  const logFd = fs.openSync(logFile, 'w');

  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'standalone.ts')], {
    cwd: REPO_ROOT,
    // A stock install unless `demo`: demo mode explicitly off, so the seeded
    // harness is the shape a stranger gets. Demo coverage runs in its own
    // launcher (launchDemo) + the 1h demo walk.
    env: {
      ...process.env,
      CHRONICLE_DATA_DIR: dataDir,
      CHRONICLE_E2E: '1',
      PORT: String(port),
      CHRONICLE_DEMO: demo ? '1' : '',
    },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  const rec: ServerRecord = { label, pid: proc.pid ?? -1, baseURL, dataDir, logFile };
  writeRecord(rec);
  proc.on('exit', (code, signal) => {
    // Only meaningful while this process is still alive; readers who missed
    // it fall back to the pid liveness check in formatRecord(). Skipped once
    // the server has been stopped on purpose, so the exit doesn't rewrite the
    // record stopServer() just deleted.
    if (stopped.has(label)) return;
    rec.exitCode = code;
    rec.exitSignal = signal;
    writeRecord(rec);
  });

  await waitForServer(`${baseURL}/api/settings`, 30_000, label);
  return { ...rec, proc };
}

// Labels stopped on purpose: their records are gone and their (imminent)
// exit event must not write them back.
const stopped = new Set<string>();

/** True when `pid` is a process whose command line is one of our standalone
 * servers — .ts as spawned here, .js for a compiled dist-server tree. */
function looksLikeOurServer(pid: number): boolean {
  if (!(pid > 0)) return false;
  let command: string;
  try {
    command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return false; // no such process
  }
  return /\bstandalone\.[jt]s\b/.test(command);
}

/** Kill a server this process spawned. The pid was recorded moments ago and
 * is ours by construction, so it is signalled without further ceremony. */
export function stopServer(handle: Pick<ServerHandle, 'pid' | 'label'>): void {
  stopped.add(handle.label);
  if (handle.pid > 0) {
    try { process.kill(handle.pid); } catch { /* already gone */ }
  }
  try { fs.rmSync(recordFile(handle.label), { force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(recordsDir(), `${handle.label}.log`), { force: true }); } catch { /* best effort */ }
}

/** Kill a server recorded by a run that is already gone. Unlike
 * `stopServer()`, this checks the pid still IS one of our servers first: a
 * pid that old may since have been recycled by an unrelated process, and
 * signalling that would be the very cross-process kill CHI #244 removed. */
export function stopStaleServer(handle: Pick<ServerHandle, 'pid' | 'label'>): void {
  if (!looksLikeOurServer(handle.pid)) {
    // Still clear the record, so the sweep's rm of the run directory is not
    // left racing a record nobody owns.
    stopped.add(handle.label);
    try { fs.rmSync(recordFile(handle.label), { force: true }); } catch { /* best effort */ }
    return;
  }
  stopServer(handle);
}

interface ScannedSession { id: string; file: string | null }
interface ScannedProject { logDir: string; sessions?: ScannedSession[] }
interface ScanResponse { 'claude-code'?: ScannedProject[] }
interface ImportResponse { imported?: number }

/** Write the big fixture + the five mini sessions into a fresh temp dir. */
function writeFixtures(fixtureDir: string): Omit<SeededData, 'dataDir' | 'fixtureDir'> {
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
  // RELATIVE TO Date.now() AT THIS POINT (seeding runs once per worker,
  // before any spec on it starts, so this is deterministic for the whole test
  // run even though the absolute timestamps drift run to run).
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
  // todayOnlySessionId: entirely inside the last 40 minutes — the naive-gate
  // control case alongside the spanning session above for window-matrix.spec.ts's
  // overlap-gate and probes.spec.ts's dense-time-axis (D12) assertions.
  //
  // These two sessions are seeded relative to seed-`now` (not local midnight),
  // so run in the first ~35 min after local midnight and their activity lands
  // just BEFORE midnight, outside a genuine `[midnight, now]` Today window —
  // this WAS an "accepted low-probability risk" that hit CI twice on PR #143.
  // CHI-376 neutralizes it: window-matrix.spec.ts freezes its browser clock to
  // local noon (`page.clock.setFixedTime`), so the Today window is a fixed 12h
  // ending at ~now and always contains both sessions regardless of wall clock.
  // Any spec asserting Today-window DATA against these two must apply the same
  // freeze (only window-matrix does today).
  writeMiniSession(fixtureDir, {
    sessionId: todayOnlySessionId,
    dateISO: new Date(nowMs - 40 * 60 * 1000).toISOString(),
    endISO: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    turns: 12,
    promptText: 'Mini fixture Today: same-day quick investigation.',
  });

  return {
    sessionId, miniAlphaId, miniBravoId, miniMinorId, spanningSessionId, todayOnlySessionId,
  };
}

/** Import the fixture sessions into a running server. Returns only once the
 * import is confirmed, so callers never observe a half-seeded data dir. */
async function importFixtures(
  baseURL: string,
  fixtureDir: string,
  ids: Omit<SeededData, 'dataDir' | 'fixtureDir'>,
): Promise<void> {
  const scanRes = await fetch(`${baseURL}/api/scan?dir=${encodeURIComponent(fixtureDir)}`);
  if (!scanRes.ok) throw new Error(`Seed scan failed (${scanRes.status}): ${await scanRes.text()}`);
  const scanJson = (await scanRes.json()) as ScanResponse;
  const project = (scanJson['claude-code'] ?? []).find((p) => p.sessions?.some((s) => s.id === ids.sessionId));
  const sessionFile = project?.sessions?.find((s) => s.id === ids.sessionId)?.file;
  if (!project || !sessionFile) {
    throw new Error(`Fixture session not found in scan result: ${JSON.stringify(scanJson)}`);
  }

  const miniFiles = [
    ids.miniAlphaId, ids.miniBravoId, ids.miniMinorId, ids.spanningSessionId, ids.todayOnlySessionId,
  ].map((id) => {
    const f = project.sessions?.find((s) => s.id === id)?.file;
    if (!f) throw new Error(`Mini fixture session not found in scan result: ${id}`);
    return f;
  });

  // Writes carry the per-boot write token (CHI-222). The browser client
  // attaches it automatically; this Node-side seed fetch must fetch it first.
  const writeToken = ((await (await fetch(`${baseURL}/api/write-token`)).json()) as { token: string }).token;
  const importRes = await fetch(`${baseURL}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chronicle-write-token': writeToken },
    body: JSON.stringify({ source: 'claude-code', logDir: project.logDir, files: [sessionFile, ...miniFiles] }),
  });
  if (!importRes.ok) throw new Error(`Seed import failed (${importRes.status}): ${await importRes.text()}`);
  const importJson = (await importRes.json()) as ImportResponse;
  if (!importJson.imported || importJson.imported < 6) {
    throw new Error(`Seed import reported ${importJson.imported ?? 0} sessions imported, expected 6: ${JSON.stringify(importJson)}`);
  }
}

/** Produce a data directory with the fixtures already imported into it. The
 * server used to run the import is stopped before this returns; the directory
 * it leaves behind is what `launchServer()` is later pointed at. */
export async function seedDataDir(label: string): Promise<SeededData> {
  ensureClientBuilt();
  // Inside this run's directory, not loose in $TMPDIR: reaping a stale run
  // then removes its fixtures and databases too, not just its state files.
  const fixtureDir = fs.mkdtempSync(path.join(currentRunDir(), 'fixture-'));
  const ids = writeFixtures(fixtureDir);
  const dataDir = fs.mkdtempSync(path.join(currentRunDir(), 'data-'));

  const seeder = await launchServer({ dataDir, label: `${label}-seed` });
  try {
    await importFixtures(seeder.baseURL, fixtureDir, ids);
  } finally {
    stopServer(seeder);
    await awaitExit(seeder.pid);
  }
  return { dataDir, fixtureDir, ...ids };
}

/** Block until a killed server's pid is really gone, so a data directory can
 * safely be handed to the next server. */
async function awaitExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
