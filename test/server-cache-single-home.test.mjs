// Structural pins for ticket #274: server/cache.ts is the ONE home for
// server-side caching, TTL included.
//
// Before this slice three private TTL caches sat outside it: commit counts and
// fixed windows in server/insights.ts, the claude-binary probe in
// server/ask.ts, each with its own map and its own expiry arithmetic.
// Behaviour is pinned where it is observable (test/server-cache.test.mjs,
// test/insights-fixed-window-cache.test.mjs, test/insights-commit-cache.test.mjs,
// test/ask-claude-bin-cache.test.mjs); what those cannot show is "written
// once", so this file reads the tracked sources, same as
// test/shared-engine-single-home.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, tracked } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';

const read = (rel) => readSource(path.join(REPO, rel));
const SERVER_TS = tracked.filter((rel) => rel.startsWith('server/') && rel.endsWith('.ts'));
const CLIENT_TS = tracked.filter((rel) => rel.startsWith('src/') && /\.tsx?$/.test(rel));

const CACHE = 'server/cache.ts';
const CLIENT_CACHE = 'src/useCachedFetch.ts';

test('expiry is decided in one place, server/cache.ts', () => {
  const found = SERVER_TS.filter((rel) => /expiresAt/.test(read(rel)));
  assert.deepEqual(found, [CACHE], 'a server module keeps its own expiry bookkeeping again');
});

// Deliberately not an allowlist of files: a fourth caller wanting a TTL is a
// legal change, and it should pass this by handing the TTL to cache.ts rather
// than by being added to a list here.
test('every server TTL constant is handed to cache.ts', () => {
  const holders = SERVER_TS.filter((rel) => rel !== CACHE && /TTL_MS/.test(read(rel)));
  assert.ok(holders.length > 0, 'the TTL sweep matched nothing, so it is pinning nothing');
  for (const rel of holders) {
    const src = read(rel);
    assert.match(src, /from '\.\.?\/cache\.ts'/, `${rel} holds a TTL without importing the cache`);
    assert.match(src, /cached\(/, `${rel} holds a TTL without calling cached()`);
  }
});

// Criterion from the ticket: the fold is server-side only. The client's
// stale-while-revalidate layer is a different thing. It caches responses in
// the browser, has no generation counter and no server to invalidate from, so
// it stays exactly where it is.
test('the client keeps a cache of its own', () => {
  assert.match(read(CLIENT_CACHE), /new Map</, 'the client stale-while-revalidate store is gone');
});

test('no client module reaches for the server cache', () => {
  const reachers = CLIENT_TS.filter((rel) => /server\/cache\.ts/.test(read(rel)));
  assert.deepEqual(reachers, [], 'a client module imports the server cache');
});
