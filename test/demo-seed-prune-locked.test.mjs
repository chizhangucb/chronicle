// Ticket #197: a stale demo cache the sweep cannot delete is not an error.
//
// A second demo may still be running out of yesterday's directory, and on
// Windows an open database file is enough on its own. Whatever the reason, the
// seed that just built a working demo must not fail over a tree it failed to
// tidy up, and must go on to sweep the stale dirs it can still reach.
//
// Its own file because server/db.ts binds its handle to CHRONICLE_DATA_DIR at
// import time: one real seed per process, so this cannot share the process
// with test/demo-seed-prune.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { seedDemo, demoDataDir } = await import('../server/demo/seed.ts');

test('a stale demo dir that cannot be removed leaves the seed successful', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root walks through the directory permissions this test locks with');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-prunetest-'));
  const locked = path.join(root, 'chronicle-demo-0-2000-01-01');
  // Registered before the locking, so a failing assert cannot strand an
  // unreadable directory in the temp dir forever.
  t.after(() => {
    try { fs.chmodSync(locked, 0o700); } catch { /* never got locked */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'chronicle.db'), 'x');
  fs.chmodSync(locked, 0o000); // unreadable, so removing it raises EACCES
  const other = path.join(root, 'chronicle-demo-0-2000-01-02');
  fs.mkdirSync(other);
  const today = path.join(root, path.basename(demoDataDir()));
  fs.mkdirSync(today);
  process.env.CHRONICLE_DATA_DIR = today;

  const res = await seedDemo(today);

  assert.equal(res.cached, false);
  assert.ok(res.seeded > 0, 'the seed did not build, so nothing was proven about surviving the failure');
  assert.ok(fs.existsSync(path.join(today, '.seed-complete')), 'the seed did not complete');
  assert.ok(fs.existsSync(locked), 'the locked dir went after all, so the failure was never exercised');
  assert.equal(fs.existsSync(other), false, 'one failure stopped the sweep reaching the next stale dir');
});
