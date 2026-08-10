import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../db.js';

export const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');

// Delete the ORIGINAL log file on disk (explicit user request only, permanent —
// the UI double-confirms). Restricted to sources where one file == one session;
// shared stores (OpenCode/Cursor DBs) would lose other sessions.
export const PER_FILE_SOURCES = new Set(['claude-code', 'codex']);

// Snapshot the whole DB before destructive deletes (project or session removal).
// At most one snapshot per hour (a multi-select Remove loop = one backup, not N);
// keeps the 2 newest. This is the recovery net for an accidental Remove-all —
// restore = quit the app and copy the snapshot back over chronicle.db.
export function backupDbBeforeDelete() {
  try {
    const dir = path.join(CHRONICLE_DIR, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.startsWith('chronicle-')).sort();
    const newest = existing[existing.length - 1];
    if (newest && Date.now() - fs.statSync(path.join(dir, newest)).mtime.getTime() < 60 * 60 * 1000) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    db.exec('BEGIN'); db.exec('COMMIT'); // barrier: no open write txn while copying
    fs.copyFileSync(path.join(CHRONICLE_DIR, 'chronicle.db'), path.join(dir, `chronicle-${stamp}.db`));
    // Keep the newest two snapshots total (the one about to be written + one prior).
    for (const f of existing.slice(0, Math.max(0, existing.length - 1))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}
