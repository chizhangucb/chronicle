// Where the ~/.aios inputs are read from (CHI-325 3c).
//
// server/laneC.ts (the LiteLLM proxy spend log) and server/machineSessions.ts
// (the headless-automation manifest) are the two readers that are NOT backed by
// chronicle.db, so seeding the demo database alone would leave the proxy lane
// and the automation-by-job table empty in demo mode. Both now resolve their
// root here instead of joining homedir() themselves.
//
// In demo the root is the seeded demo directory's own `aios/` folder, so the
// operator's real ~/.aios is never read in demo, and the demo never depends on
// the operator having one.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function aiosRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHRONICLE_DEMO === '1' && env.CHRONICLE_DATA_DIR) {
    return join(env.CHRONICLE_DATA_DIR, 'aios');
  }
  return join(homedir(), '.aios');
}
