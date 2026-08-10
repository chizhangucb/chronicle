// Shared test helper for modules that touch server/db.js.
//
// db.js reads process.env.CHRONICLE_DATA_DIR AT IMPORT TIME and opens
// <dir>/chronicle.db immediately at module scope. So any test that needs an
// isolated database MUST set CHRONICLE_DATA_DIR to a fresh temp dir BEFORE
// importing db.js (or anything that imports db.js, like causality.js) — a
// static top-of-file `import` runs before test code gets a chance to set the
// env var, so callers must use a dynamic `await import()` after calling this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Creates a fresh temp dir, points CHRONICLE_DATA_DIR at it, dynamically
// imports server/db.js (bound to that temp dir), and returns both the module
// and a teardown function that removes the temp dir.
export async function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-test-'));
  process.env.CHRONICLE_DATA_DIR = dir;
  // Bare specifier (no query string) so this resolves to the SAME cached
  // module instance that server/causality.js's `import { db } from './db.js'`
  // resolves to (same absolute file URL) — one shared DatabaseSync, not two
  // separate connections to the same file.
  const dbModule = await import('../server/db.js');
  function teardown() {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { dbModule, dir, teardown };
}
