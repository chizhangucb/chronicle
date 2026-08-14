// Unit tests for src/charts/timeBuckets.ts (feedback-round Task 3 + D12): the
// shared LOCAL-time bucket dense-fill + label helpers used by the Home
// spend-over-time chart (daily/hourly), the ProjectDetail trend, and (Task 18)
// the Explore rollup chart's hourly/daily/weekly/monthly buckets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densifyBuckets, dayKeyOf, hourKeyOf, monthKeyOf, fmtDayLabel, fmtHourLabel, fmtHourOfDay } from '../src/charts/timeBuckets.ts';

test('densifyBuckets: day — fills gaps between first and last present key', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08-10', '2026-08-13'], 'day'),
    ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'],
  );
});

test('densifyBuckets: day — a single key returns just that key', () => {
  assert.deepEqual(densifyBuckets(['2026-08-10'], 'day'), ['2026-08-10']);
});

test('densifyBuckets: day — unsorted, duplicate input is order-independent', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08-12', '2026-08-10', '2026-08-12', '2026-08-11'], 'day'),
    ['2026-08-10', '2026-08-11', '2026-08-12'],
  );
});

test('densifyBuckets: empty input returns empty output', () => {
  assert.deepEqual(densifyBuckets([], 'day'), []);
  assert.deepEqual(densifyBuckets([], 'hour'), []);
});

test('densifyBuckets: hour — fills gaps within one day', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08-13T09', '2026-08-13T12'], 'hour'),
    ['2026-08-13T09', '2026-08-13T10', '2026-08-13T11', '2026-08-13T12'],
  );
});

test('densifyBuckets: hour — fills across a local day boundary', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08-13T23', '2026-08-14T01'], 'hour'),
    ['2026-08-13T23', '2026-08-14T00', '2026-08-14T01'],
  );
});

test('dayKeyOf / hourKeyOf: format matches server/windowUsage.ts localBucketKeyFromIso', () => {
  const d = new Date(2026, 7, 13, 9); // Aug 13 2026, 9am LOCAL — month is 0-indexed
  assert.equal(dayKeyOf(d), '2026-08-13');
  assert.equal(hourKeyOf(d), '2026-08-13T09');
});

test('dayKeyOf / hourKeyOf: pad single-digit month/day/hour', () => {
  const d = new Date(2026, 0, 5, 3);
  assert.equal(dayKeyOf(d), '2026-01-05');
  assert.equal(hourKeyOf(d), '2026-01-05T03');
});

test('densifyBuckets round-trips with dayKeyOf/hourKeyOf: every produced key parses back to a real local Date one unit apart', () => {
  const keys = densifyBuckets(['2026-02-27', '2026-03-02'], 'day'); // crosses a month boundary
  assert.deepEqual(keys, ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
});

// Task 18/D12: 'week' and 'month' units, added so Explore's weekly/monthly
// rollups can also be dense-filled (not just hourly/daily).
test('densifyBuckets: week — fills gaps 7 days at a time between Monday-aligned keys', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08-03', '2026-08-24'], 'week'), // both Mondays
    ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'],
  );
});

test('densifyBuckets: week — a single key returns just that key', () => {
  assert.deepEqual(densifyBuckets(['2026-08-03'], 'week'), ['2026-08-03']);
});

test('densifyBuckets: week — fills across a month boundary', () => {
  assert.deepEqual(
    densifyBuckets(['2026-02-23', '2026-03-09'], 'week'),
    ['2026-02-23', '2026-03-02', '2026-03-09'],
  );
});

test('densifyBuckets: month — fills gaps between two months in the same year', () => {
  assert.deepEqual(
    densifyBuckets(['2026-05', '2026-08'], 'month'),
    ['2026-05', '2026-06', '2026-07', '2026-08'],
  );
});

test('densifyBuckets: month — fills across a year boundary', () => {
  assert.deepEqual(
    densifyBuckets(['2025-11', '2026-02'], 'month'),
    ['2025-11', '2025-12', '2026-01', '2026-02'],
  );
});

test('densifyBuckets: month — a single key returns just that key', () => {
  assert.deepEqual(densifyBuckets(['2026-08'], 'month'), ['2026-08']);
});

test('densifyBuckets: month — unsorted, duplicate input is order-independent', () => {
  assert.deepEqual(
    densifyBuckets(['2026-08', '2026-05', '2026-08', '2026-06'], 'month'),
    ['2026-05', '2026-06', '2026-07', '2026-08'],
  );
});

test('densifyBuckets: empty input returns empty output for week and month too', () => {
  assert.deepEqual(densifyBuckets([], 'week'), []);
  assert.deepEqual(densifyBuckets([], 'month'), []);
});

test('monthKeyOf: format matches server/explore.ts bucketExpr monthly (\'YYYY-MM\')', () => {
  const d = new Date(2026, 7, 13); // Aug 13 2026 LOCAL — month is 0-indexed
  assert.equal(monthKeyOf(d), '2026-08');
});

test('monthKeyOf: pads a single-digit month', () => {
  const d = new Date(2026, 0, 5);
  assert.equal(monthKeyOf(d), '2026-01');
});

test('fmtDayLabel: formats a LOCAL day key directly, no UTC double-shift', () => {
  // If this routed through `new Date(`${key}T00:00:00Z`)` (the bug this task
  // fixes), a timezone west of UTC would print "Aug 12" here instead.
  assert.equal(fmtDayLabel('2026-08-13', 'en-US'), 'Aug 13');
});

test('fmtHourLabel: compact "9 AM" / "10 PM" style per the brief', () => {
  assert.equal(fmtHourLabel('2026-08-13T09', 'en-US'), '9 AM');
  assert.equal(fmtHourLabel('2026-08-13T22', 'en-US'), '10 PM');
});

test('fmtHourOfDay: formats hour-of-day (0-23) as "9 AM" / "10 PM" for subgroup labels', () => {
  assert.equal(fmtHourOfDay('9', 'en-US'), '9 AM');
  assert.equal(fmtHourOfDay('22', 'en-US'), '10 PM');
  assert.equal(fmtHourOfDay('0', 'en-US'), '12 AM');
  assert.equal(fmtHourOfDay('12', 'en-US'), '12 PM');
});

test('fmtHourOfDay: handles numeric strings edge cases', () => {
  assert.equal(fmtHourOfDay('00', 'en-US'), '12 AM');
  assert.equal(fmtHourOfDay('23', 'en-US'), '11 PM');
});

test('fmtHourOfDay: returns original input for invalid hour values', () => {
  assert.equal(fmtHourOfDay('25', 'en-US'), '25');
  assert.equal(fmtHourOfDay('-1', 'en-US'), '-1');
  assert.equal(fmtHourOfDay('abc', 'en-US'), 'abc');
});
