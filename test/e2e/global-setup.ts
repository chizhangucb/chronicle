// Runs once before any spec, and is guaranteed by Playwright to finish first
// — see helpers.ts's top comment for why that ordering matters here (avoids
// racing "server listening" against "fixture imported").
//
// Provisions ONE seeded data directory and ONE server per Playwright worker,
// keyed by worker index, and persists each instance's connection info to that
// worker's own state file for its specs (and global-teardown) to read. Each
// worker seeds its own directory rather than copying a template: the measured
// seed cost is ~0.4s, so a copy step would optimise a cost that isn't there.
//
// Everything it writes goes in a state directory belonging to THIS RUN, which
// this hook creates and publishes to the worker processes via the environment
// (CHI #244 — harness.ts's RUNS_ROOT comment has the why). A concurrent suite
// run on the same machine is therefore invisible to this one.
import fs from 'node:fs';
import type { FullConfig } from '@playwright/test';
import {
  createRunDir, staleRunDirs, adoptRunDir, workerStateFile, launchSeeded, listSeedStates, stopStaleSeeded,
} from './helpers.ts';
import { ensureClientBuilt } from './harness.ts';

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Leftovers from an interrupted previous run (teardown never got to run).
  // Only runs whose owner process is gone — never a suite running right now.
  for (const stale of staleRunDirs()) {
    adoptRunDir(stale);
    for (const state of listSeedStates()) stopStaleSeeded(state);
    fs.rmSync(stale, { recursive: true, force: true });
  }

  createRunDir();

  // Once, up front: the per-worker seeds below run concurrently and must not
  // race each other into the same `npm run build`.
  ensureClientBuilt();

  const workers = Math.max(1, config.workers ?? 1);
  await Promise.all(
    Array.from({ length: workers }, async (_unused, workerIndex) => {
      const { proc, ...state } = await launchSeeded(workerIndex);
      fs.writeFileSync(workerStateFile(workerIndex), JSON.stringify(state));
      // Detach: nothing here should hold the run open waiting on a server
      // that is meant to outlive this hook and serve every spec after it.
      // global-teardown kills it by pid once the run is done.
      proc.unref();
    }),
  );
}
