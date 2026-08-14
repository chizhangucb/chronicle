// Shared, pure bucket-key → short axis label formatter for the four Explore
// time rollups (hourly/daily/weekly/monthly). Framework-free, like
// shared/contextWindows.ts — extracted out of server/explore.ts (which still
// re-exports `bucketLabel` for its own callers/tests) so the CLIENT can format
// a label for a client-synthesized (zero-filled, D12 dense-fill) bucket key in
// the exact same style as a real server-supplied bucket, without duplicating
// the format rules or importing a server module (server/explore.ts pulls in
// `./db.ts` at module scope, which is unusable in a browser bundle).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Deterministic short axis label from a bucket key (branch on key length so one
// formatter serves all four rollups; no locale, matching the mono axis style).
// Key formats (see server/explore.ts `bucketExpr`): hourly "YYYY-MM-DDTHH"
// (13 chars), daily/weekly "YYYY-MM-DD" (10 chars, weekly = that week's Monday
// date), monthly "YYYY-MM" (7 chars).
export function bucketLabel(key: string): string {
  const mon = (m: string): string => MONTHS[Math.max(0, Math.min(11, Number(m) - 1))];
  if (key.length === 13) return `${mon(key.slice(5, 7))} ${Number(key.slice(8, 10))} ${key.slice(11, 13)}h`; // hourly
  if (key.length === 10) return `${mon(key.slice(5, 7))} ${Number(key.slice(8, 10))}`; // daily / weekly (Monday date)
  if (key.length === 7) return `${mon(key.slice(5, 7))} ${key.slice(0, 4)}`; // monthly
  return key;
}
