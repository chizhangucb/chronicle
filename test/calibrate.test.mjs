import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateByBucket } from '../server/calibrate.ts';

test('calibrateByBucket: distributes billed total by char share', () => {
  const out = calibrateByBucket([{ key: 'a', chars: 75 }, { key: 'b', chars: 25 }], 1000);
  assert.deepEqual(out, [{ key: 'a', tokens: 750 }, { key: 'b', tokens: 250 }]);
});
test('calibrateByBucket: zero total chars → all zero, no divide-by-zero', () => {
  const out = calibrateByBucket([{ key: 'a', chars: 0 }, { key: 'b', chars: 0 }], 1000);
  assert.deepEqual(out, [{ key: 'a', tokens: 0 }, { key: 'b', tokens: 0 }]);
});
test('calibrateByBucket: empty buckets → empty', () => {
  assert.deepEqual(calibrateByBucket([], 1000), []);
});
