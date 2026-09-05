// Counterpart to global-setup.ts: kills every worker's seeded standalone
// server and removes its temp fixture/data dirs once the whole run is done.
import fs from 'node:fs';
import { RUN_DIR, listSeedStates, stopSeeded } from './helpers.ts';

export default async function globalTeardown(): Promise<void> {
  // Empty when global-setup never got far enough to write any state.
  for (const state of listSeedStates()) stopSeeded(state);
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
