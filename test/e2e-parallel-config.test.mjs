// CHI #245 regression guard: the e2e gate must stay parallel, sharded, and
// honest about flakes.
//
// The suite went from 1 worker / 1 runner to 2 workers across 3 CI shards.
// Every one of those settings is a single line someone can quietly revert
// while debugging a flake — and reverting them looks like a fix, because a
// serial suite hides races instead of failing on them. Same shape as the
// other config/workflow guards (test/repo-shape.test.mjs): read the real
// files, assert the real values, run in the `check` job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

test('the e2e suite runs on more than one worker', () => {
  assert.equal(typeof config.workers, 'number', 'workers must be a fixed number, not left to Playwright');
  assert.ok(config.workers > 1, `expected more than one worker, got ${config.workers}`);
});

test('parallelism is full: tests split within a file, not just across files', () => {
  assert.equal(config.fullyParallel, true);
});

test('a spec that passes only on retry fails the job', () => {
  assert.equal(config.retries, 1, 'one retry absorbs a genuine blip; more hides races');
  assert.equal(config.failOnFlakyTests, true, 'without this the retry silently launders a race into a pass');
});

test('the CI e2e job is sharded across at least 3 runners', () => {
  const matrix = /shard: \[([^\]]+)\]/.exec(ci);
  assert.ok(matrix, 'ci.yml declares no e2e shard matrix');
  const shards = matrix[1].split(',').map((s) => Number(s.trim()));
  assert.ok(shards.length >= 3, `expected at least 3 shards, got ${shards.length}`);
  assert.deepEqual(shards, shards.map((_unused, i) => i + 1), 'shards must be 1..N, the form --shard=i/N expects');
  assert.match(
    ci,
    new RegExp(`--shard=\\$\\{\\{ matrix\\.shard \\}\\}/${shards.length}`),
    `every shard must be run as i/${shards.length}`,
  );
});

test('the shards still roll up under the required check named `e2e`', () => {
  // Branch protection requires `e2e` by name. A matrix job publishes one
  // check per shard, so the matrix lives under a different id and `e2e` is
  // the roll-up that fails when any shard did not succeed.
  const jobIds = [...ci.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
  assert.ok(jobIds.includes('e2e'), 'ci.yml declares no `e2e` job for branch protection to require');
  assert.ok(jobIds.includes('e2e-shard'), 'ci.yml declares no `e2e-shard` matrix job');
  assert.match(ci, /needs: e2e-shard/, '`e2e` does not depend on the shards');
  assert.match(ci, /needs\.e2e-shard\.result/, '`e2e` never checks the shards\' result, so it cannot go red');
});
