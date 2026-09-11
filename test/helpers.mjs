// Shared test helper for modules that touch server/db.ts.
//
// Importing db.ts does nothing now (issue #275): openDatabase(dir) is what opens
// the database, applies the schema and runs the backfills, and the handle it
// returns is the one every server module reads through getDb(). The env var is
// still set here because server/config.ts freezes the data folder at import, and
// that folder is what the config reader and the snapshot writer use — so callers
// still reach db.ts through a dynamic `await import()` after calling this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Creates a fresh temp dir, points CHRONICLE_DATA_DIR at it, opens a database
// there, and returns the module, the open handle, the dir, and a teardown
// function that removes the temp dir. `withTempApp()` below is the one-liner for
// a test that wants the whole API over that database.
export async function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-test-'));
  process.env.CHRONICLE_DATA_DIR = dir;
  // Bare specifier (no query string) so this resolves to the SAME cached
  // module instance that a server module's own `import { getDb } from './db.ts'`
  // resolves to (same absolute file URL) — one shared DatabaseSync, not two
  // separate connections to the same file.
  const dbModule = await import('../server/db.ts');
  const db = dbModule.openDatabase(dir);
  function teardown() {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { dbModule, db, dir, teardown };
}

// The whole API over a fresh temp database, in one call: the seam issue #275
// bought. No router mounting, no import-order dance.
export async function withTempApp() {
  const temp = await withTempDb();
  const { createApp } = await import('../server/api.ts');
  return { ...temp, app: createApp(temp.db) };
}
