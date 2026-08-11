// Pure helpers for the Working Rhythm strip (src/insights/WorkingRhythm.tsx):
// streaks, active-day counts, peak hour, and a playful token-comparison
// footnote. No React, no fetch — straight array math, unit-tested directly
// (test/insights-stats.test.mjs) via Node's native TS stripping.

export interface DayCount { day: string; count: number; }

// Longest run of consecutive calendar days with count > 0, ending at `today`
// (today's own zero-count doesn't break an in-progress streak check for
// "current streak" — callers pass `asOf` = today's date string).
export function currentStreak(days: DayCount[], asOf: string): number {
  const byDay = new Map(days.map((d) => [d.day, d.count]));
  let streak = 0;
  let cursor = new Date(asOf);
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if ((byDay.get(key) ?? 0) > 0) { streak++; cursor = new Date(cursor.getTime() - 86400000); }
    else break;
  }
  return streak;
}

export function longestStreak(days: DayCount[]): number {
  const sorted = [...days].filter((d) => d.count > 0).map((d) => d.day).sort();
  let longest = 0, run = 0, prev: string | null = null;
  for (const day of sorted) {
    if (prev && new Date(day).getTime() - new Date(prev).getTime() === 86400000) run++;
    else run = 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  return longest;
}

export function activeDaysCount(days: DayCount[], windowDays: number, asOf: string): number {
  const cutoff = new Date(new Date(asOf).getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  return days.filter((d) => d.day >= cutoff && d.count > 0).length;
}

export function peakHour(hourly: { dow: number; hour: number; count: number }[]): number | null {
  if (!hourly.length) return null;
  const byHour = new Map<number, number>();
  for (const h of hourly) byHour.set(h.hour, (byHour.get(h.hour) ?? 0) + h.count);
  return [...byHour.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// A playful, deterministic token-comparison footnote. Fixed reference: the
// complete works of Shakespeare is ~900,000 words ≈ 1.2M tokens (a common
// rough estimate, ~1.3 tokens/word).
const SHAKESPEARE_TOKENS = 1_200_000;
export function shakespeareMultiple(totalTokens: number): number {
  return Math.round((totalTokens / SHAKESPEARE_TOKENS) * 10) / 10;
}
