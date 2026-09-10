// Structural pins for ticket #274: server/cache.ts is the ONE home for
// server-side caching, TTL included.
//
// Before this slice three private TTL caches sat outside it — commit counts
// and fixed windows in server/insights.ts, the claude-binary probe in
// server/ask.ts — each with its own map, its own expiry arithmetic and its own
// blind spot around invalidateCache(). Behaviour is pinned where it is
// observable (test/server-cache.test.mjs, test/insights-fixed-window-cache.test.mjs,
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

test('every server TTL constant is handed to cache.ts', () => {
  const holders = SERVER_TS.filter((rel) => rel !== CACHE && /TTL_MS/.test(read(rel)));
  // Not empty: the callers this slice folded in still carry their own TTL,
  // which is the point — the value stays with the caller, the mechanism does not.
  assert.deepEqual(holders.slice().sort(), ['server/ask.ts', 'server/insights.ts']);
  for (const rel of holders) {
    const src = read(rel);
    assert.match(src, /from '\.\.?\/cache\.ts'/, `${rel} holds a TTL without importing the cache`);
    assert.match(src, /cached\(/, `${rel} holds a TTL without calling cached()`);
  }
});

// Criterion from the ticket: the fold is server-side only. The client's
// stale-while-revalidate layer is a different thing — it caches responses in
// the browser, has no generation counter and no server to invalidate from —
// and stays exactly where it is.
test('the client keeps its own stale-while-revalidate cache', () => {
  const src = read(CLIENT_CACHE);
  assert.match(src, /const cache = new Map<string, unknown>\(\)/, 'the client SWR store moved or was renamed');
});

test('no client module reaches for the server cache', () => {
  const reachers = CLIENT_TS.filter((rel) => /server\/cache\.ts/.test(read(rel)));
  assert.deepEqual(reachers, [], 'a client module imports the server cache');
});
