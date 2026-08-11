import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitCountSince } from '../server/git.ts';

test('commitCountSince: non-git dir returns 0, does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-notgit-'));
  assert.equal(commitCountSince(dir, null), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitCountSince: counts all commits with sinceIso=null, filters with a cutoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-git-'));
  const run = (args, env = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'first', '--date=2026-01-01T00:00:00'], { GIT_COMMITTER_DATE: '2026-01-01T00:00:00' });
  fs.writeFileSync(path.join(dir, 'a.txt'), '2');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'second', '--date=2026-08-01T00:00:00'], { GIT_COMMITTER_DATE: '2026-08-01T00:00:00' });

  assert.equal(commitCountSince(dir, null), 2);
  assert.equal(commitCountSince(dir, '2026-06-01T00:00:00.000Z'), 1);
  assert.equal(commitCountSince(dir, '2026-12-01T00:00:00.000Z'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
