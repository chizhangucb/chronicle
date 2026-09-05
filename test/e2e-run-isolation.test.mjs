// CHI #244: two `npm run test:e2e` runs on one machine used to share a single
// fixed state directory ($TMPDIR/chronicle-e2e). The second run's globalSetup
// killed the first run's servers and deleted its state files, and the first
// run's globalTeardown then did the same to the second — the "seeded server
// dies mid-run" cascade. Each run now gets its own directory under a shared
// root, and the stale sweep only reaps runs whose owner process is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  RUNS_ROOT, createRunDir, currentRunDir, adoptRunDir, staleRunDirs,
} from './e2e/harness.ts';

function withEnv(fn) {
  const saved = process.env.CHRONICLE_E2E_RUN_DIR;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.CHRONICLE_E2E_RUN_DIR;
    else process.env.CHRONICLE_E2E_RUN_DIR = saved;
  }
}

test('two runs on one machine never share a state directory', () => {
  withEnv(() => {
    const a = createRunDir();
    const b = createRunDir();
    assert.notEqual(a, b);
    assert.equal(path.dirname(a), RUNS_ROOT);
    assert.equal(path.dirname(b), RUNS_ROOT);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});

test('workers resolve the run dir their runner published, not a fixed path', () => {
  withEnv(() => {
    const dir = createRunDir();
    assert.equal(process.env.CHRONICLE_E2E_RUN_DIR, dir);
    assert.equal(currentRunDir(), dir);
    // A worker process is forked with the runner's env; adoptRunDir() is what
    // it uses, and it must not invent a directory of its own.
    delete process.env.CHRONICLE_E2E_RUN_DIR;
    assert.throws(() => currentRunDir(), /CHRONICLE_E2E_RUN_DIR/);
    adoptRunDir(dir);
    assert.equal(currentRunDir(), dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('the stale sweep reaps dead runs and never a live one', () => {
  withEnv(() => {
    const live = createRunDir();
    const dead = createRunDir();
    // Re-stamp `dead` as owned by a pid that cannot be running.
    fs.writeFileSync(path.join(dead, 'owner.json'), JSON.stringify({ pid: 2 ** 31 - 1 }));
    const stale = staleRunDirs();
    assert.ok(stale.includes(dead), 'a run whose owner is gone is stale');
    assert.ok(!stale.includes(live), 'a run whose owner is alive is never stale');
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(dead, { recursive: true, force: true });
  });
});
