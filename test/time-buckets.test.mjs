// Unit tests for src/charts/timeBuckets.ts (feedback-round Task 3 + D12): the
// shared LOCAL-time bucket dense-fill + label helpers used by the Home
// spend-over-time chart (daily/hourly) and the ProjectDetail trend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densifyBuckets, dayKeyOf, hourKeyOf, fmtDayLabel, fmtHourLabel } from '../src/charts/timeBuckets.ts';

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

test('fmtDayLabel: formats a LOCAL day key directly, no UTC double-shift', () => {
  // If this routed through `new Date(`${key}T00:00:00Z`)` (the bug this task
  // fixes), a timezone west of UTC would print "Aug 12" here instead.
  assert.equal(fmtDayLabel('2026-08-13', 'en-US'), 'Aug 13');
});

test('fmtHourLabel: compact "9 AM" / "10 PM" style per the brief', () => {
  assert.equal(fmtHourLabel('2026-08-13T09', 'en-US'), '9 AM');
  assert.equal(fmtHourLabel('2026-08-13T22', 'en-US'), '10 PM');
});
