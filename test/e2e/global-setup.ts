// Runs once before any spec, and is guaranteed by Playwright to finish first
// — see helpers.ts's top comment for why that ordering matters here (avoids
// racing "server listening" against "fixture imported").
//
// Provisions ONE seeded data directory and ONE server per Playwright worker,
// keyed by worker index, and persists each instance's connection info to that
// worker's own state file for its specs (and global-teardown) to read. Each
// worker seeds its own directory rather than copying a template: the measured
// seed cost is ~0.4s, so a copy step would optimise a cost that isn't there.
import fs from 'node:fs';
import type { FullConfig } from '@playwright/test';
import { RUN_DIR, workerStateFile, launchSeeded, listSeedStates, stopSeeded } from './helpers.ts';
import { ensureClientBuilt } from './harness.ts';

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Leftovers from an interrupted previous run (teardown never got to run).
  for (const stale of listSeedStates()) stopSeeded(stale);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });

  // Once, up front: the per-worker seeds below run concurrently and must not
  // race each other into the same `npm run build`.
  ensureClientBuilt();

  const workers = Math.max(1, config.workers ?? 1);
  await Promise.all(
    Array.from({ length: workers }, async (_unused, workerIndex) => {
      const { proc, ...state } = await launchSeeded(workerIndex);
      fs.writeFileSync(workerStateFile(workerIndex), JSON.stringify(state));
      // Detach: the spawned server must outlive this globalSetup process exit
      // (Playwright runs globalSetup in a short-lived process). global-teardown
      // kills it by pid once the run is done.
      proc.unref();
    }),
  );
}
