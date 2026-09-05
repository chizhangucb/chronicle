// Playwright E2E harness: one isolated Chronicle instance PER WORKER, each
// seeded with the Task-1 big fixture session (120 subagents, 5000 messages —
// test/fixtures/gen-big-session.mjs) plus five mini sessions.
//
// Design choice (documented per the task brief's "pick the simpler" note):
// Playwright's built-in `webServer` config option only supports "poll a URL
// until it responds" as its readiness signal — it can't distinguish "the
// server is listening" from "the fixture has finished importing", and the
// import (5000 messages + 120 subagent files) takes long enough that a naive
// `webServer` setup would race: the first spec could hit an empty Home page.
// Instead the whole provisioning — build, generate the fixture, seed a data
// dir through the real import API, spawn the server specs talk to — runs to
// completion inside Playwright's `globalSetup`, which is guaranteed to finish
// before any test starts.
//
// `globalSetup` and the test workers are separate processes, so the
// connection info is persisted to disk rather than kept in a module-scope
// variable. It is persisted PER WORKER INDEX (`workerStateFile`), and a spec
// calls `readSeedState()`, which resolves the file for the worker it is
// running on (`TEST_PARALLEL_INDEX`). There is no fixed shared state path, so
// two workers never share a server or a database. `globalTeardown` reads
// every worker's file to kill the servers and clean up the temp dirs.
//
// The seed/launch seam itself, and the per-server records that let a failing
// spec report *why* its server is gone, live in harness.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import {
  RUN_DIR, workerStateFile, seedDataDir, launchServer, stopServer,
  describeDeadServers,
  type SeededData, type ServerHandle,
} from './harness.ts';

// Specs and the global hooks import from here only; harness.ts is the seam's
// implementation. Re-exported are just the names they actually reach for.
export { REPO_ROOT, RUN_DIR, workerStateFile } from './harness.ts';

// Reference viewport widths the overflow smoke check runs at (spec §5.1,
// step 2d): a laptop, a common desktop, and a wide desktop.
export const WIDTHS = [1024, 1366, 1728];

export interface SeedState extends SeededData {
  baseURL: string;
  pid: number;
  /** Names this instance's server record (harness.ts) — the thing a failing
   * spec quotes an exit status and log tail from. */
  label: string;
}

/** Which worker this module is being loaded on. Playwright sets
 * TEST_PARALLEL_INDEX in every worker process; it is absent in globalSetup /
 * globalTeardown, where 0 is the right default. */
export function currentWorkerIndex(): number {
  const raw = process.env.TEST_PARALLEL_INDEX;
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** The seeded instance belonging to the worker running this spec. */
export function readSeedState(workerIndex: number = currentWorkerIndex()): SeedState {
  const file = workerStateFile(workerIndex);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No seeded Chronicle instance for worker ${workerIndex} (${file}). ` +
      'globalSetup provisions one instance per worker; run the suite through `npm run test:e2e`.',
    );
  }
  return JSON.parse(raw) as SeedState;
}

/** Every provisioned instance, for globalTeardown. */
export function listSeedStates(): SeedState[] {
  let names: string[];
  try { names = fs.readdirSync(RUN_DIR); } catch { return []; }
  const out: SeedState[] = [];
  for (const name of names) {
    if (!/^worker-\d+\.json$/.test(name)) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(RUN_DIR, name), 'utf8')) as SeedState); } catch { /* mid-write */ }
  }
  return out;
}

/** Seed a data directory and launch the server specs talk to against it. The
 * two halves are separate operations (harness.ts); this is their composition,
 * used once per worker by globalSetup. */
export async function launchSeeded(workerIndex = 0): Promise<SeedState & { proc: ServerHandle['proc'] }> {
  const label = `worker-${workerIndex}`;
  const seeded = await seedDataDir(label);
  const server = await launchServer({ dataDir: seeded.dataDir, label });
  return { ...seeded, baseURL: server.baseURL, pid: server.pid, label, proc: server.proc };
}

export function stopSeeded(state: Pick<SeedState, 'pid' | 'dataDir' | 'fixtureDir' | 'label'>): void {
  stopServer(state);
  for (const dir of [state.dataDir, state.fixtureDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface DemoServer {
  baseURL: string;
  proc: ServerHandle['proc'];
  dataDir: string;
  pid: number;
  label: string;
}

let demoSeq = 0;

/** Launch a standalone server in DEMO mode (CHRONICLE_DEMO=1): synthetic
 * sessions and projects, so a zero-data console still renders a populated
 * product. Caller stops it in afterAll. Like every other spawned server it
 * gets a record, so a spec failing against a dead demo server says why. */
export async function launchDemo(): Promise<DemoServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-e2e-demo-'));
  // Unique across workers AND across spec files sharing one worker.
  const label = `demo-w${currentWorkerIndex()}-${process.pid}-${demoSeq++}`;
  const server = await launchServer({ dataDir, label, demo: true });
  return { baseURL: server.baseURL, proc: server.proc, dataDir, pid: server.pid, label };
}

export function stopDemo(server: DemoServer): void {
  stopServer(server);
  try { fs.rmSync(server.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A failing spec's first question is almost always "was the server even
// there?". This auto fixture answers it: when a test fails AND some recorded
// server is no longer running, that server's exit status and the tail of its
// log are appended to the failure, instead of leaving a bare
// `net::ERR_CONNECTION_REFUSED`. A passing run touches nothing, and a failure
// with every server healthy (an ordinary assertion miss) is left alone.
export const test = base.extend<{ serverDiagnostics: void }>({
  serverDiagnostics: [async ({}, use, testInfo) => {
    await use();
    if (testInfo.status === testInfo.expectedStatus) return;
    const diag = describeDeadServers();
    if (!diag) return;
    const note = `\n\n--- Chronicle e2e: a server this run depends on is not running ---\n${diag}`;
    await testInfo.attach('chronicle-server-status', { body: diag, contentType: 'text/plain' });
    for (const err of testInfo.errors) {
      // Reporters print `stack` when there is one and fall back to `message`,
      // so append to both to be sure the note is actually shown.
      if (typeof err.message === 'string') err.message += note;
      if (typeof err.stack === 'string') err.stack += note;
    }
  }, { auto: true }],
});

export { expect };
