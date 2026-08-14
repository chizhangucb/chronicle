// Unit tests for shared/bucketLabel.ts (feedback-round Task 18/D12): extracted
// out of server/explore.ts so the CLIENT can format a label for a
// client-synthesized (dense-fill) bucket key identically to a real
// server-supplied one. server/explore.ts re-exports the same function —
// test/explore.test.mjs's 'bucketLabel / bucketExpr shape the four
// granularities' test covers that re-export; this file locks the shared
// module's own contract directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketLabel } from '../shared/bucketLabel.ts';

test('bucketLabel: hourly key (13 chars)', () => {
  assert.equal(bucketLabel('2026-08-09T14'), 'Aug 9 14h');
});

test('bucketLabel: daily / weekly key (10 chars)', () => {
  assert.equal(bucketLabel('2026-08-09'), 'Aug 9');
});

test('bucketLabel: monthly key (7 chars)', () => {
  assert.equal(bucketLabel('2026-08'), 'Aug 2026');
});

test('bucketLabel: unrecognized key length passes through unchanged', () => {
  assert.equal(bucketLabel('bogus'), 'bogus');
});
