// Pure-function tests for src/insights/stats.ts (streaks, peak hour, the
// Shakespeare token-comparison footnote). No DB, no fixtures — straight unit
// tests over plain arrays, run directly via Node's native TS stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStreak, longestStreak, activeDaysCount, peakHour, shakespeareMultiple } from '../src/insights/stats.ts';

test('currentStreak: counts consecutive active days ending today', () => {
  const days = [{ day: '2026-08-08', count: 3 }, { day: '2026-08-09', count: 1 }, { day: '2026-08-10', count: 5 }];
  assert.equal(currentStreak(days, '2026-08-10'), 3);
});

test('currentStreak: breaks on a gap', () => {
  const days = [{ day: '2026-08-08', count: 3 }, { day: '2026-08-10', count: 5 }]; // gap on the 9th
  assert.equal(currentStreak(days, '2026-08-10'), 1);
});

test('longestStreak: finds the longest run anywhere in the window', () => {
  const days = [
    { day: '2026-08-01', count: 1 }, { day: '2026-08-02', count: 1 }, { day: '2026-08-03', count: 1 },
    { day: '2026-08-05', count: 1 }, { day: '2026-08-10', count: 1 },
  ];
  assert.equal(longestStreak(days), 3);
});

test('activeDaysCount: counts active days within a trailing window', () => {
  const days = [{ day: '2026-07-01', count: 1 }, { day: '2026-08-09', count: 2 }, { day: '2026-08-10', count: 0 }];
  assert.equal(activeDaysCount(days, 30, '2026-08-10'), 1);
});

test('peakHour: the hour with the most total messages across all days', () => {
  const hourly = [{ dow: 1, hour: 14, count: 5 }, { dow: 2, hour: 14, count: 6 }, { dow: 1, hour: 9, count: 3 }];
  assert.equal(peakHour(hourly), 14);
});

test('peakHour: empty input returns null', () => {
  assert.equal(peakHour([]), null);
});

test('shakespeareMultiple: rounds to 1 decimal', () => {
  assert.equal(shakespeareMultiple(2_520_000), 2.1);
});
