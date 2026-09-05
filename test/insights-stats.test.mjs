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

test('currentStreak: today has zero messages but yesterday+ had activity — today\'s zero must NOT break the streak', () => {
  // No entry at all for today (2026-08-10) — same as count 0. Per the
  // GitHub-style contract this documents, a user mid-streak who just hasn't
  // sent a message yet today should still see their real streak, not 0.
  const days = [{ day: '2026-08-08', count: 3 }, { day: '2026-08-09', count: 2 }];
  assert.equal(currentStreak(days, '2026-08-10'), 2);
});

test('currentStreak: today zero AND yesterday zero is a real gap — streak is 0', () => {
  // Only today gets the "skip if zero" treatment; a zero on any OTHER day
  // (here, yesterday) is a genuine gap and still breaks the count.
  const days = [{ day: '2026-08-07', count: 3 }]; // 08-08 and 08-09 both missing/zero
  assert.equal(currentStreak(days, '2026-08-10'), 0);
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

test('activeDaysCount: n never exceeds the window ( was 31/30 on a fully-active month)', () => {
  // 31 consecutive active days ending at asOf. The inclusive 30-day window is
  // asOf and the 29 days before it, so exactly 30 fall inside — the 31st (the
  // oldest) is out. The count must be 30, never 31.
  const asOf = '2026-08-31';
  const days = Array.from({ length: 31 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 7, 1) + i * 86400000).toISOString().slice(0, 10),
    count: 3,
  }));
  const n = activeDaysCount(days, 30, asOf);
  assert.equal(n, 30);
  assert.ok(n <= 30, `active days ${n} must not exceed the 30-day window`);
});

test('activeDaysCount: a stray future-dated row does not inflate the count', () => {
  const days = [{ day: '2026-08-31', count: 1 }, { day: '2026-09-05', count: 9 }];
  assert.equal(activeDaysCount(days, 30, '2026-08-31'), 1); // the 09-05 row is after asOf
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
