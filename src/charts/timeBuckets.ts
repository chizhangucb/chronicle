// Shared LOCAL-time bucket helpers for time-series charts (feedback-round
// Task 3 + D12: every bucketed chart the client renders must be DENSE —
// zero-filled from its first to its last bucket, so equal bar spacing always
// represents equal time, never a collapsed run of empty buckets reading as
// one wide bar). Bucket KEYS themselves are produced server-side by
// server/windowUsage.ts (`bucketKeyExpr`/`localBucketKeyFromIso`) via SQL
// `strftime(..., 'localtime')` — already local, in one of two formats:
//   day:  'YYYY-MM-DD'
//   hour: 'YYYY-MM-DDTHH'
// so this module's `dayKeyOf`/`hourKeyOf` (used for client-only bucketing,
// e.g. ProjectDetail's per-session trend) MUST produce the exact same format
// from a Date's LOCAL getters, or the two key spaces silently stop matching.
//
// NEVER reconstruct a Date from a bare day key with `${key}T00:00:00Z` — that
// re-parses an already-local calendar date as UTC midnight, shifting the
// displayed day by ±1 in any timezone that isn't UTC (the exact double-shift
// bug this task fixes). Every formatter below builds its Date from the key's
// own numeric parts instead, via the local (non-UTC) constructor.

// 'week' and 'month' were added for Task 18/D12 (Explore's weekly/monthly
// rollups) — server/explore.ts's `bucketExpr` emits weekly keys in the SAME
// 'YYYY-MM-DD' format as daily (that week's Monday date, via SQLite's `date()`
// weekday offset), so 'week' reuses day-key parsing/formatting and just steps
// 7 days at a time instead of 1. Monthly keys are 'YYYY-MM'.
export type BucketUnit = 'hour' | 'day' | 'week' | 'month';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface DayParts { y: number; mo: number; d: number; }
interface HourParts extends DayParts { h: number; }
interface MonthParts { y: number; mo: number; }

function parseDayKey(key: string): DayParts {
  const [y, mo, d] = key.split('-').map(Number);
  return { y, mo, d };
}
function parseHourKey(key: string): HourParts {
  const [datePart, hourPart] = key.split('T');
  const { y, mo, d } = parseDayKey(datePart);
  return { y, mo, d, h: Number(hourPart) };
}
function parseMonthKey(key: string): MonthParts {
  const [y, mo] = key.split('-').map(Number);
  return { y, mo };
}

// Local day/hour key FROM a Date, in the same format the server emits —
// the inverse of parseDayKey/parseHourKey, used when the client buckets its
// own data (e.g. ProjectDetail's per-session trend, which has no server-side
// bucketed endpoint) instead of consuming a server-supplied bucket key.
export function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function hourKeyOf(d: Date): string {
  return `${dayKeyOf(d)}T${pad2(d.getHours())}`;
}
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// A local Date constructed FROM a bucket key, for stepping day-by-day/
// hour-by-hour — always via the local (non-UTC) `Date` constructor, never a
// parsed ISO string, so DST transitions are handled by the same rules the
// browser uses for every other local Date arithmetic in this app.
function dateOfDayKey(key: string): Date {
  const { y, mo, d } = parseDayKey(key);
  return new Date(y, mo - 1, d);
}
function dateOfHourKey(key: string): Date {
  const { y, mo, d, h } = parseHourKey(key);
  return new Date(y, mo - 1, d, h);
}
function dateOfMonthKey(key: string): Date {
  const { y, mo } = parseMonthKey(key);
  return new Date(y, mo - 1, 1);
}

// Zero-fills a contiguous range of bucket keys spanning the earliest to the
// latest key present in `keys` (order-independent, duplicates collapsed) —
// D12: so a chart's bar/point spacing always represents equal time, even when
// some buckets in the middle have no data. Empty input returns an empty
// array (nothing to densify, nothing to chart).
export function densifyBuckets(keys: string[], unit: BucketUnit): string[] {
  if (!keys.length) return [];
  const sorted = [...new Set(keys)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const out: string[] = [];
  if (unit === 'day' || unit === 'week') {
    // 'week' keys are already Monday-aligned 'YYYY-MM-DD' dates (see the
    // BucketUnit comment above), so stepping 7 days at a time from a Monday
    // lands on the next Monday — no separate week-key parser needed.
    const step = unit === 'week' ? 7 : 1;
    let cur = dateOfDayKey(first);
    const end = dateOfDayKey(last);
    while (cur.getTime() <= end.getTime()) {
      out.push(dayKeyOf(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + step);
    }
  } else if (unit === 'month') {
    let cur = dateOfMonthKey(first);
    const end = dateOfMonthKey(last);
    while (cur.getTime() <= end.getTime()) {
      out.push(monthKeyOf(cur));
      // JS Date normalizes an overflowed month (e.g. month=12 for Dec + 1)
      // into the next year automatically, so no separate year-rollover branch.
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  } else {
    let cur = dateOfHourKey(first);
    const end = dateOfHourKey(last);
    while (cur.getTime() <= end.getTime()) {
      out.push(hourKeyOf(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours() + 1);
    }
  }
  return out;
}

// Defensive cap for a dense-filled bucket-key array (D12 follow-up, Task 18
// review finding #1): densifyBuckets has no inherent upper bound — hourly
// never coarsens server-side (server/explore.ts), so an hourly rollup over a
// multi-year "All" range densifies to tens of thousands of keys (verified: an
// 11-year span produces 101,821). Feeding that wholesale into a Recharts
// <BarChart>/<Brush> is a real perf risk, not just a legibility one. Keeps
// the MOST RECENT `max` keys — `keys` is assumed already chronologically
// sorted (as densifyBuckets always returns) — and reports whether/how much
// was dropped, so the caller can render an honest "showing last N of M" note
// instead of silently truncating.
export interface CappedBuckets { keys: string[]; truncated: boolean; total: number; }
export function capDenseBuckets(keys: string[], max: number): CappedBuckets {
  if (keys.length <= max) return { keys, truncated: false, total: keys.length };
  return { keys: keys.slice(-max), truncated: true, total: keys.length };
}

// Local day-key formatter, e.g. "Aug 13" — the key IS already local, so it's
// formatted straight from its own numeric parts (see the header comment on
// why this never routes through a UTC-parsed Date).
export function fmtDayLabel(key: string, locale: string): string {
  const { y, mo, d } = parseDayKey(key);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(y, mo - 1, d));
}

// Internal: formats a given hour (0–23) using locale-appropriate Intl.DateTimeFormat.
// Shared by both fmtHourLabel and fmtHourOfDay to avoid duplication of the
// "9 AM" / "10 PM" rendering logic.
function formatHourWith(hour: number, locale: string): string {
  // Use a dummy date (1970-01-01); only the hour matters for formatting.
  return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).format(new Date(1970, 0, 1, hour));
}

// Local hour-key formatter, compact + mono-friendly per the brief: "9 AM" /
// "10 PM". Built from the key's own local numeric parts, same rule as
// fmtDayLabel above.
export function fmtHourLabel(key: string, locale: string): string {
  const { y, mo, d, h } = parseHourKey(key);
  return formatHourWith(h, locale);
}

// Hour-of-day formatter for subgroup labels (0–23 → "9 AM" / "10 PM").
// Takes the raw hour number as a string (e.g., "9", "10", "22") and formats
// it using the shared formatHourWith() logic.
export function fmtHourOfDay(hourStr: string, locale: string): string {
  const h = Number(hourStr);
  if (Number.isNaN(h) || h < 0 || h > 23) return hourStr;
  return formatHourWith(h, locale);
}
