// The commit counter has one home (issue #265, finding F3 of the #183 audit).
//
// `server/git.ts` used to carry sync/async twins of the same shell-out:
// `commitCountSince` (execFileSync) for the project page and
// `commitCountSinceAsync` (libuv thread pool) for Insights, which counts per
// project on every request. Two spellings of one number is one place for the
// range semantics to drift, so the async one is the only counter left and
// every caller awaits it.
//
// The counter's behaviour is pinned by test/git.test.mjs and the project
// route's number by test/project-commits.test.mjs; this file pins only that
// there is nowhere for the sync twin to come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('server/git.ts exports exactly one commit counter, the async one', () => {
  const text = read('server/git.ts');
  const counters = [...text.matchAll(/export\s+(?:async\s+)?function\s+(commitCount[A-Za-z0-9_]*)/g)]
    .map((m) => m[1]);
  assert.deepEqual(counters, ['commitCountSinceAsync'], 'the sync twin commitCountSince should be gone');
});

test('every commit-count caller reaches for the async counter', () => {
  for (const rel of ['server/routes/projects.ts', 'server/insights.ts']) {
    const text = read(rel);
    assert.match(text, /commitCountSinceAsync/, `${rel} should count commits through the async counter`);
    assert.equal(/commitCountSince\b(?!Async)/.test(text), false,
      `${rel} should not name the sync counter`);
  }
});
