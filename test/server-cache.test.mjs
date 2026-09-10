import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheSize, cached, invalidateCache } from '../server/cache.ts';

test('cached: calls compute once across two calls with the same key', () => {
  let calls = 0;
  const compute = () => { calls++; return 'value'; };
  assert.equal(cached('k1', compute), 'value');
  assert.equal(cached('k1', compute), 'value');
  assert.equal(calls, 1);
});

test('cached: after invalidateCache(), the next call recomputes', () => {
  let calls = 0;
  const compute = () => { calls++; return calls; };
  assert.equal(cached('k2', compute), 1);
  assert.equal(cached('k2', compute), 1);
  assert.equal(calls, 1);
  invalidateCache();
  assert.equal(cached('k2', compute), 2);
  assert.equal(calls, 2);
});

test('cached: keys are independent', () => {
  let callsA = 0, callsB = 0;
  const computeA = () => { callsA++; return 'a'; };
  const computeB = () => { callsB++; return 'b'; };
  assert.equal(cached('kA', computeA), 'a');
  assert.equal(cached('kB', computeB), 'b');
  assert.equal(cached('kA', computeA), 'a');
  assert.equal(cached('kB', computeB), 'b');
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
});

// TTL (ticket #274). The server's three private TTL caches (insights' commit
// counts and fixed windows, ask's claude-binary probe) fold into this module,
// so expiry is a property of `cached` and is pinned here rather than in each
// caller. Time is driven with node:test's Date mock so the pins are exact
// rather than sleep-timed.
test('cached: an entry with a TTL is a hit until the TTL elapses', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const compute = () => { calls++; return calls; };
  assert.equal(cached('ttl-hit', compute, 1000), 1);
  t.mock.timers.tick(999);
  assert.equal(cached('ttl-hit', compute, 1000), 1);
  assert.equal(calls, 1);
});

test('cached: an entry with a TTL recomputes once the TTL elapses', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const compute = () => { calls++; return calls; };
  assert.equal(cached('ttl-expiry', compute, 1000), 1);
  t.mock.timers.tick(1001);
  assert.equal(cached('ttl-expiry', compute, 1000), 2);
  assert.equal(calls, 2);
});

test('cached: an entry with no TTL never expires on time alone', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const compute = () => { calls++; return calls; };
  assert.equal(cached('ttl-absent', compute), 1);
  t.mock.timers.tick(365 * 86400_000);
  assert.equal(cached('ttl-absent', compute), 1);
  assert.equal(calls, 1);
});

// An entry has ONE staleness rule. A TTL entry's input is not the database, so
// a DB write says nothing about it: autosync re-imports a live session every
// few seconds, and generation-keying the five-minute commit memo on top would
// wipe it before it ever paid for itself.
test('cached: invalidateCache() leaves a TTL entry alone', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const compute = () => { calls++; return calls; };
  assert.equal(cached('ttl-gen', compute, 60_000), 1);
  invalidateCache();
  invalidateCache();
  assert.equal(cached('ttl-gen', compute, 60_000), 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(60_001);
  assert.equal(cached('ttl-gen', compute, 60_000), 2);
});

// Keys rotate by design (a URL carrying a day range, a minute-quantized
// cutoff), so a cache that only ever adds would grow for the life of the
// process. cacheSize() is the only seam that can see the sweep.
test('cached: stale entries are swept, so the map does not grow without bound', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  for (let i = 0; i < 400; i++) cached(`sweep-${i}`, () => i);
  const grown = cacheSize();
  assert.ok(grown > 256, `expected the map to grow past the sweep threshold, got ${grown}`);
  invalidateCache();
  // One miss past the threshold is what triggers the sweep; every entry above
  // is dead by now, so only the new one survives it.
  cached('sweep-after', () => 'fresh');
  assert.ok(cacheSize() < grown, `expected the sweep to drop stale entries, size stayed at ${cacheSize()}`);
  assert.equal(cached('sweep-after', () => 'recomputed'), 'fresh', 'the sweep dropped a live entry');
});
