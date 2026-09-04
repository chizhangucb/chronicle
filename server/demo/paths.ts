// Where the ~/.aios inputs are read from (CHI-325 3c).
//
// server/machineSessions.ts (the headless-automation manifest) is not backed by
// chronicle.db, so seeding the demo database alone would leave the
// automation-by-job table empty in demo mode. It resolves its root here instead
// of joining homedir() itself. server/laneC.ts used to as well; since issue #186
// it resolves the spend log under CHRONICLE_DATA_DIR directly, with the same
// demo guarantee.
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
