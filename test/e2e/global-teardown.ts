// Counterpart to global-setup.ts: kills every worker's seeded standalone
// server and removes this run's state directory (which holds the temp fixture
// and data dirs too) once the whole run is done. It touches only THIS run's
// directory, so a suite running concurrently on the same machine is left
// alone — CHI #244.
import fs from 'node:fs';
import { listSeedStates, stopSeeded, currentRunDir } from './helpers.ts';

export default async function globalTeardown(): Promise<void> {
  // Empty when global-setup never got far enough to write any state.
  for (const state of listSeedStates()) stopSeeded(state);
  try { fs.rmSync(currentRunDir(), { recursive: true, force: true }); } catch { /* best effort */ }
}
