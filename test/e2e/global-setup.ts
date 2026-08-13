// Runs once before any spec, and is guaranteed by Playwright to finish first
// — see helpers.ts's top comment for why that ordering matters here (avoids
// racing "server listening" against "fixture imported"). Persists the
// connection info to STATE_FILE for specs + global-teardown to read.
import fs from 'node:fs';
import { launchSeeded, STATE_FILE } from './helpers.ts';

export default async function globalSetup(): Promise<void> {
  const { proc, ...state } = await launchSeeded();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  // Detach: the spawned server must outlive this globalSetup process exit
  // (Playwright runs globalSetup in a short-lived process). global-teardown
  // kills it by pid once the run is done.
  proc.unref();
}
