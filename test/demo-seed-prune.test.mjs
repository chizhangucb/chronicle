// Ticket #197: the demo cache prunes the days it has left behind.
//
// The demo data dir is keyed on (corpus version, today's local date), so
// crossing midnight builds a NEW directory and the old one is dead weight:
// ~7MB per day the operator opened demo. seedDemo removes those once it has a
// database of its own to serve.
//
// The deletion is the dangerous part, so the guards get their own pins: only
// paths under the OS temp dir, only names starting with the exact
// `chronicle-demo-` prefix, never through a symlink, and never loud enough to
// fail a seed that otherwise worked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { seedDemo, demoDataDir } = await import('../server/demo/seed.ts');

// A scratch temp root, so a pruning test cannot reach the demo cache of the
// machine it runs on (or of another test file running beside it).
function scratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-prunetest-'));
}

function dirWithFile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'x');
  return dir;
}

test("a successful seed removes yesterday's demo dir and leaves unrelated temp dirs alone", async () => {
  const root = scratchRoot();
  // Today's dir carries the real cache-key name; the stale one is an older day.
  const today = path.join(root, path.basename(demoDataDir()));
  const yesterday = dirWithFile(path.join(root, 'chronicle-demo-0-2000-01-01'));
  const unrelated = dirWithFile(path.join(root, 'chronicle-test-abc123'));
  // Prefix matching is exact: `chronicle-demo` with no separator is a
  // different name, not an older demo cache.
  const lookalike = dirWithFile(path.join(root, 'chronicle-demoish-abc'));

  fs.mkdirSync(today, { recursive: true });
  process.env.CHRONICLE_DATA_DIR = today;
  const res = await seedDemo(today);

  assert.equal(res.cached, false, 'the seed should have built, not been served from cache');
  assert.ok(res.seeded > 0, 'the seed imported nothing, so nothing was proven about a successful build');
  assert.equal(fs.existsSync(yesterday), false, "yesterday's demo dir survived the seed");
  assert.ok(fs.existsSync(path.join(unrelated, 'payload.txt')), 'an unrelated temp dir was deleted');
  assert.ok(fs.existsSync(path.join(lookalike, 'payload.txt')), 'a chronicle-demo LOOKALIKE was deleted');
  assert.ok(fs.existsSync(path.join(today, '.seed-complete')), "today's dir lost its completion marker");

  fs.rmSync(root, { recursive: true, force: true });
});
