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

export type BucketUnit = 'hour' | 'day';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface DayParts { y: number; mo: number; d: number; }
interface HourParts extends DayParts { h: number; }

function parseDayKey(key: string): DayParts {
  const [y, mo, d] = key.split('-').map(Number);
  return { y, mo, d };
}
function parseHourKey(key: string): HourParts {
  const [datePart, hourPart] = key.split('T');
  const { y, mo, d } = parseDayKey(datePart);
  return { y, mo, d, h: Number(hourPart) };
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
  if (unit === 'day') {
    let cur = dateOfDayKey(first);
    const end = dateOfDayKey(last);
    while (cur.getTime() <= end.getTime()) {
      out.push(dayKeyOf(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
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
