// Unit tests for shared/usage.ts (#301): the ONE token cell, the ONE parse of a
// `sessions.usage` blob and the ONE cell addition every surface now reads
// through. Before this module the same five-number cell had five names in two
// field-name dialects and the JSON was parsed by five functions; these tests
// stand at the shared function, covering each dialect those copies handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, addCell, emptyCell } from '../shared/usage.ts';

test('parseUsage: reads the stored dialect (cacheWrite5m / cacheWrite1h) as-is', () => {
  const parsed = parseUsage(JSON.stringify({
    'claude-sonnet-5': { input: 120, output: 34, cacheRead: 880, cacheWrite5m: 51, cacheWrite1h: 9 },
  }));
  assert.deepEqual(parsed, {
    'claude-sonnet-5': { input: 120, output: 34, cacheRead: 880, cacheWrite5m: 51, cacheWrite1h: 9 },
  });
});

test('parseUsage: folds the legacy pre-TTL-split `cacheWrite` onto the 5m tier', () => {
  // Pre-TTL-split imports only carry `cacheWrite`, and those writes were billed
  // at the 5-minute rate — the fold every copy of this parse did by hand.
  const parsed = parseUsage(JSON.stringify({ 'gpt-5': { input: 90, output: 22, cacheRead: 300, cacheWrite: 15 } }));
  assert.deepEqual(parsed['gpt-5'], { input: 90, output: 22, cacheRead: 300, cacheWrite5m: 15, cacheWrite1h: 0 });
});

test('parseUsage: an explicit cacheWrite5m wins over a legacy cacheWrite on the same entry', () => {
  const parsed = parseUsage(JSON.stringify({ m: { cacheWrite5m: 7, cacheWrite: 99 } }));
  assert.equal(parsed.m.cacheWrite5m, 7);
});

test('parseUsage: missing fields read zero, so every cell has all five numbers', () => {
  const parsed = parseUsage(JSON.stringify({ m: { input: 5 } }));
  assert.deepEqual(parsed.m, { input: 5, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

test('parseUsage: null, empty and unparseable blobs are an empty map, never a throw', () => {
  assert.deepEqual(parseUsage(null), {});
  assert.deepEqual(parseUsage(''), {});
  assert.deepEqual(parseUsage('{not json'), {});
});

test('parseUsage: a non-object entry is skipped rather than becoming a NaN cell', () => {
  const parsed = parseUsage(JSON.stringify({ good: { input: 1 }, bad: null, alsoBad: 7 }));
  assert.deepEqual(Object.keys(parsed), ['good']);
});

test('parseUsage: a null field value reads zero (JSON nulls come out of some sources)', () => {
  const parsed = parseUsage(JSON.stringify({ m: { input: null, output: 3, cacheRead: null } }));
  assert.deepEqual(parsed.m, { input: 0, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

test('addCell: sums the five numbers field by field', () => {
  const a = { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 };
  const b = { input: 10, output: 20, cacheRead: 30, cacheWrite5m: 40, cacheWrite1h: 50 };
  assert.deepEqual(addCell(a, b), { input: 11, output: 22, cacheRead: 33, cacheWrite5m: 44, cacheWrite1h: 55 });
});

test('addCell: returns a new cell and leaves both operands untouched', () => {
  const a = emptyCell();
  const b = { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 };
  const sum = addCell(a, b);
  assert.notEqual(sum, a);
  assert.notEqual(sum, b);
  assert.deepEqual(a, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual(b, { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 });
});

test('addCell: folding a parsed session over an accumulator totals the session', () => {
  // The accumulate-into-a-map shape every engine builds out of these two.
  const parsed = parseUsage(JSON.stringify({
    a: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 },
    b: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
  }));
  const total = Object.values(parsed).reduce(addCell, emptyCell());
  assert.deepEqual(total, { input: 11, output: 22, cacheRead: 33, cacheWrite5m: 44, cacheWrite1h: 5 });
});
