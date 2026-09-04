// server/dataDir.ts
// One definition of Chronicle's data root, so every reader and writer lands in
// the same place (issue #186).
//
// server/db.ts freezes it at import time (its handle is bound then), while
// server/laneC.ts must resolve per call: in demo the dir is only known once the
// demo dir is seeded. Both go through here rather than each joining homedir()
// with their own copy of the rule. litellm/lane_c_spend_logger.py mirrors this
// on the producer side.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$CHRONICLE_DATA_DIR`, else `~/.chronicle`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CHRONICLE_DATA_DIR?.trim();
  return raw ? raw : join(homedir(), '.chronicle');
}

/** `~/x` to `<home>/x`. The producer expands the tilde
 *  (litellm/lane_c_spend_logger.py `default_spend_path`), and a shell that
 *  sources a quoted `LANE_C_SPEND_LOG="~/..."` does not, so this side has to
 *  expand too or the two disagree. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
