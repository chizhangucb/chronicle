// Counterpart to global-setup.ts: kills the seeded standalone server and
// removes its temp fixture/data dirs once the whole run (all specs) is done.
import { readSeedState, stopSeeded } from './helpers.ts';

export default async function globalTeardown(): Promise<void> {
  let state;
  try { state = readSeedState(); } catch { return; } // global-setup never got far enough to write it
  stopSeeded(state);
}
