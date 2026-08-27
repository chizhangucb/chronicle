// Regression pin for the pre-PR staleness guard (CHI-362). Exercises the guard's
// behind / ahead / conflict logic on throwaway git fixtures, so the CI job that
// runs scripts/landing_preflight.mjs can't silently rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPreflight } from '../scripts/landing_preflight.mjs';

/**
 * Build a temp repo with a `main` branch and a `feature` branch, positioned per
 * the requested scenario. The guard is run with `target: 'main'` and
 * `fetch: false` so no network/remote is involved; `main` here stands in for the
 * `origin/main` the guard resolves in real use.
 */
function makeRepo(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-preflight-'));
  const run = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00', GIT_AUTHOR_DATE: '2026-01-01T00:00:00' },
    });
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const commit = (msg) => {
    run(['add', '-A']);
    run(['commit', '-q', '-m', msg]);
  };

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);

  // Shared base commit on main.
  write('shared.txt', 'base\n');
  write('other.txt', 'base\n');
  commit('base');

  // Cut feature from the base.
  run(['checkout', '-q', '-b', 'feature']);

  return { dir, run, write, commit };
}

test('up-to-date branch (even with main) -> pass, no conflicts', () => {
  const { dir, run } = makeRepo();
  // feature == main (no divergence).
  const r = runPreflight({ repo: dir, target: 'main', fetch: false });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.behind, 0);
  assert.deepEqual(r.conflicts, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ahead of main (feature has extra commits, main unchanged) -> pass', () => {
  const { dir, run, write, commit } = makeRepo();
  write('feature-only.txt', 'x\n');
  commit('feature work');
  const r = runPreflight({ repo: dir, target: 'main', fetch: false });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.behind, 0);
  assert.equal(r.ahead, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('behind main but no overlap -> fail, stale, empty conflict map', () => {
  const { dir, run, write, commit } = makeRepo();
  // Advance main on a DIFFERENT file than feature will touch.
  run(['checkout', '-q', 'main']);
  write('main-only.txt', 'new on main\n');
  commit('main advances');
  run(['checkout', '-q', 'feature']);
  // feature adds its own non-overlapping commit -> diverged, behind by 1.
  write('feature-only.txt', 'y\n');
  commit('feature work');

  const r = runPreflight({ repo: dir, target: 'main', fetch: false });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.stale, true);
  assert.equal(r.behind, 1);
  assert.equal(r.clean, true, 'non-overlapping change should merge clean');
  assert.deepEqual(r.conflicts, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('behind main AND conflicting -> fail with the conflicting file in the map', () => {
  const { dir, run, write, commit } = makeRepo();
  // main edits shared.txt.
  run(['checkout', '-q', 'main']);
  write('shared.txt', 'MAIN edit\n');
  commit('main edits shared');
  // feature edits the SAME file differently -> real merge conflict.
  run(['checkout', '-q', 'feature']);
  write('shared.txt', 'FEATURE edit\n');
  commit('feature edits shared');

  const r = runPreflight({ repo: dir, target: 'main', fetch: false });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.stale, true);
  assert.equal(r.behind, 1);
  assert.equal(r.clean, false);
  assert.deepEqual(r.conflicts, ['shared.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the merge dry-run restores the tree: HEAD unchanged and no dirty files', () => {
  const { dir, run, write, commit } = makeRepo();
  run(['checkout', '-q', 'main']);
  write('shared.txt', 'MAIN edit\n');
  commit('main edits shared');
  run(['checkout', '-q', 'feature']);
  write('shared.txt', 'FEATURE edit\n');
  commit('feature edits shared');

  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  runPreflight({ repo: dir, target: 'main', fetch: false });
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(headAfter, headBefore, 'HEAD must not move');
  assert.equal(status, '', 'working tree must be clean after the dry-run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uncommitted tracked change is refused (guard will not touch it)', () => {
  const { dir, run, write } = makeRepo();
  write('shared.txt', 'uncommitted edit\n'); // shared.txt is tracked
  assert.throws(() => runPreflight({ repo: dir, target: 'main', fetch: false }), /uncommitted tracked/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('untracked scratch file does NOT block the guard', () => {
  const { dir, write } = makeRepo();
  write('scratch.tmp', 'untracked junk\n'); // never `git add`ed
  const r = runPreflight({ repo: dir, target: 'main', fetch: false });
  assert.equal(r.verdict, 'pass'); // even with main, untracked file ignored
  fs.rmSync(dir, { recursive: true, force: true });
});
