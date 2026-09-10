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

const { seedDemo, demoDataDir, pruneStaleDemoDirs } = await import('../server/demo/seed.ts');

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

test("a successful seed removes yesterday's demo dir and leaves unrelated temp dirs alone", async (t) => {
  const root = scratchRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Today's dir carries the real cache-key name; the stale one is an older day.
  const today = path.join(root, path.basename(demoDataDir()));
  const yesterday = dirWithFile(path.join(root, 'chronicle-demo-0-2000-01-01'));
  const unrelated = dirWithFile(path.join(root, 'chronicle-test-abc123'));
  // Prefix matching is exact: `chronicle-demo` with no separator is a
  // different name, not an older demo cache.
  const lookalike = dirWithFile(path.join(root, 'chronicle-demoish-abc'));
  // Nor is the prefix on its own the key: a live mkdtemp scratch dir wearing it
  // (test/demo-mode.test.mjs makes exactly this one) has no day key on the end.
  const scratch = dirWithFile(path.join(root, 'chronicle-demo-tx-a1b2c3'));

  fs.mkdirSync(today, { recursive: true });
  process.env.CHRONICLE_DATA_DIR = today;
  const res = await seedDemo(today);

  assert.equal(res.cached, false, 'the seed should have built, not been served from cache');
  assert.ok(res.seeded > 0, 'the seed imported nothing, so nothing was proven about a successful build');
  assert.equal(fs.existsSync(yesterday), false, "yesterday's demo dir survived the seed");
  assert.ok(fs.existsSync(path.join(unrelated, 'payload.txt')), 'an unrelated temp dir was deleted');
  assert.ok(fs.existsSync(path.join(lookalike, 'payload.txt')), 'a chronicle-demo LOOKALIKE was deleted');
  assert.ok(fs.existsSync(path.join(scratch, 'payload.txt')), 'a prefixed mkdtemp scratch dir with no day key was deleted');
  assert.ok(fs.existsSync(path.join(today, '.seed-complete')), "today's dir lost its completion marker");
});

test('a symlink wearing the demo prefix is left where it lies, never followed', async (t) => {
  // The temp dir is world-writable, so a link named like a demo cache is the
  // cheapest way to aim the sweep at something it was never meant to touch.
  // The sweep must not treat the link as one of its own directories at all:
  // that it is still there afterwards is what says the link was never walked.
  const root = scratchRoot();
  const elsewhere = scratchRoot();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  const target = dirWithFile(path.join(elsewhere, 'precious'));
  const link = path.join(root, 'chronicle-demo-0-2000-01-01');
  fs.symlinkSync(target, link, 'dir');
  const today = path.join(root, path.basename(demoDataDir()));
  fs.mkdirSync(today, { recursive: true });

  const removed = pruneStaleDemoDirs(today);

  assert.deepEqual(removed, [], 'the sweep took a symlink for a stale demo dir');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself was deleted');
  assert.ok(fs.existsSync(path.join(target, 'payload.txt')), "a symlink's target was emptied");
});

test('nothing outside the OS temp dir is swept, whatever the seed dir says', async (t) => {
  // The sweep is scoped to the seed dir's own parent, so the pin is: point the
  // OS temp dir somewhere else and the same siblings become untouchable.
  const root = scratchRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = dirWithFile(path.join(root, 'chronicle-demo-0-2000-01-01'));
  const today = path.join(root, path.basename(demoDataDir()));
  fs.mkdirSync(today, { recursive: true });
  t.mock.method(os, 'tmpdir', () => path.join(root, 'somewhere-else'));

  const removed = pruneStaleDemoDirs(today);

  assert.deepEqual(removed, [], 'the sweep deleted outside the OS temp dir');
  assert.ok(fs.existsSync(path.join(stale, 'payload.txt')), 'a dir outside the OS temp dir was deleted');
});
