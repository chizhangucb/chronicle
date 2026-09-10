import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, snapshotDb } from '../db.ts';

export const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');

// Snapshot the whole DB before destructive deletes (project or session removal).
// At most one snapshot per hour (a multi-select Remove loop = one backup, not N);
// keeps the 2 newest. This is the recovery net for an accidental Remove-all —
// restore = quit the app and copy the snapshot back over chronicle.db.
export function backupDbBeforeDelete(): void {
  snapshotDb();
}
