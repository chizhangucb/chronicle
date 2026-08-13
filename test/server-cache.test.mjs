import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached, invalidateCache } from '../server/cache.ts';

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
