// server/dataDir.ts
// One definition of Chronicle's data root, so every reader and writer lands in
// the same place (issue #186).
//
// server/db.ts freezes it at import time (its handle is bound then). Every
// reader and writer goes through here rather than joining homedir() with its
// own copy of the rule.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$CHRONICLE_DATA_DIR`, else `~/.chronicle`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CHRONICLE_DATA_DIR?.trim();
  return raw ? raw : join(homedir(), '.chronicle');
}

