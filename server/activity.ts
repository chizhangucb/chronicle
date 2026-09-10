// Home dashboard data engine (Task 13, spec §2.1). Backs the Activity block
// (live rows + since-you-left rows) and the Burn tile (current-window spend vs
// a baseline) on the `/` dashboard. Mirrors server/insights.ts patterns: the
// scope clause, minor gate and range fragments all come from the one query
// context (server/scope.ts), and it reads token MAGNITUDE from the
// authoritative per-session `sessions.usage` blob (the
// same source Insights/Explore price from) rather than per-message columns.
//
// PRICE TABLE STAYS CLIENT-SIDE (hard constraint): every token figure is
// returned as per-model token CELLS (the shape of a `sessions.usage` entry);
// the client prices them via src/models.ts `costOf`. The server never computes
// dollars — including "top session", which it picks by total tokens (a
// price-free proxy) and returns with its cells so the client can price it.
import { db } from './db.ts';
import { liveWatcherSessionIds } from './live.ts';
import { bucketedUsage } from './rangeUsage.ts';
import { queryContext, rangeOf, whereOf, type QueryContext, type Range, type Scope } from './scope.ts';
import { sessionDisplayName } from '../shared/sessionName.ts';
import { addCellInto, emptyCell, parseUsage, totalTokens, USAGE_FIELDS, type UsageByModel, type UsageCell } from '../shared/usage.ts';

const DAY = 86400000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const LIVE_CAP = 6;
const RECENT_CAP = 10;
// The trailing complete-days window the "Today" burn baseline medians over.
const MEDIAN_DAYS = 14;

// The feed's shapes live in shared/results.ts (#307); the Home dashboard reads
// them straight from there instead of keeping a hand-typed mirror.
import type { ActivityBurn, ActivityResult, ActivitySessionLite, AnomalyDayCells } from '../shared/results.ts';

interface SessionRowLite {
  id: string;
  project_id: number;
  project_name: string;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  usage: string | null;
  error_count: number | null;
}

// Merge a session's cells into an accumulator (per-model, per-field sum).
function addUsage(acc: UsageByModel, cells: UsageByModel): void {
  for (const [model, cell] of Object.entries(cells)) addCellInto(acc, model, cell);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Sum per-session usage over a started_at window [from, to) (either bound may
// be null = unbounded), in the caller's scope.
function sumRange(q: QueryContext, from: string | null, to: string | null): UsageByModel {
  const w = whereOf(
    q.where,
    from != null ? { sql: 'AND s.started_at >= ?', params: [from] } : '',
    to != null ? { sql: 'AND s.started_at < ?', params: [to] } : '',
  );
  const rows = db.prepare(
    `SELECT s.usage FROM sessions s WHERE ${w.sql}`,
  ).all(...w.params) as unknown as { usage: string | null }[];
  const acc: UsageByModel = {};
  for (const r of rows) addUsage(acc, parseUsage(r.usage));
  return acc;
}

// Median of the trailing MEDIAN_DAYS COMPLETE LOCAL calendar days' per-model
// daily token totals. Each field is medianed independently across the 14 days
// (missing days count as 0), yielding a priceable "typical day" cell per model
// — the client prices it for the baseline spend figure.
//
// LOCAL days, like every other bucket in Chronicle (server/rangeUsage.ts's
// bucketKeyExpr, insights.ts's calendar heatmap). This used to bucket by UTC
// day — `substr(started_at,1,10)` against UTC midnights — so an evening
// session west of UTC (or an early-morning one east of it) was medianed into
// the wrong day, or fell outside the range entirely, and "above your usual"
// was off by a timezone (ticket #304).
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function medianBaseline(q: QueryContext): UsageByModel {
  const now = q.range.now;
  // Calendar arithmetic (setDate), not `midnight - n*DAY`: a DST shift makes a
  // day 23 or 25 hours long, and only the calendar walk lands on real local
  // midnights either side of it.
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const midnightBack = (back: number): Date => {
    const d = new Date(todayMidnight);
    d.setDate(d.getDate() - back);
    return d;
  };
  const from = midnightBack(MEDIAN_DAYS).toISOString();   // 14 complete days ago
  const to = todayMidnight.toISOString();                 // exclusive: today's local midnight

  const w = whereOf(q.where, { sql: 'AND s.started_at >= ? AND s.started_at < ?', params: [from, to] });
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', s.started_at, 'localtime') AS day, s.usage
     FROM sessions s
     WHERE ${w.sql}`,
  ).all(...w.params) as unknown as { day: string; usage: string | null }[];

  // day → model → summed cell
  const byDay = new Map<string, UsageByModel>();
  for (const r of rows) {
    const acc = byDay.get(r.day) ?? {};
    addUsage(acc, parseUsage(r.usage));
    byDay.set(r.day, acc);
  }
  const days = Array.from({ length: MEDIAN_DAYS }, (_, i) => localDayKey(midnightBack(i + 1))); // d=1..14
  const models = new Set<string>();
  for (const m of byDay.values()) for (const model of Object.keys(m)) models.add(model);

  const out: UsageByModel = {};
  for (const model of models) {
    const cell = emptyCell();
    for (const f of USAGE_FIELDS) {
      cell[f] = median(days.map((day) => byDay.get(day)?.[model]?.[f] ?? 0));
    }
    out[model] = cell;
  }
  return out;
}

// `range.now` is the wall clock the range/live/baseline math reads: production
// passes rangeOf(days) (real Date.now()), a test pins it so it is not coupled
// to the real time of day (the "Today" range is only minutes wide just after
// local midnight, which the fixtures cannot represent).
export function computeActivity(scope: Scope, range: Range, sinceIso: string | null = null): ActivityResult {
  const q = queryContext(scope, range);
  const days = range.days;
  const now = range.now;
  // since defaults to a trailing 12h window (see task brief).
  const since = sinceIso && !Number.isNaN(Date.parse(sinceIso)) ? sinceIso : new Date(now - 12 * 3600000).toISOString();
  const watchers = liveWatcherSessionIds();

  const listWhere = whereOf(q.where);
  const rows = db.prepare(
    `SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
            s.started_at, s.ended_at, s.usage, s.error_count
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE ${listWhere.sql}
     ORDER BY COALESCE(s.ended_at, s.started_at) DESC
     LIMIT 100`,
  ).all(...listWhere.params) as unknown as SessionRowLite[];

  const toLite = (r: SessionRowLite, live: boolean): ActivitySessionLite => ({
    id: r.id,
    name: sessionDisplayName(r, 'id'),
    projectName: r.project_name,
    source: r.source,
    live,
    endedAt: r.ended_at,
    tokensByModel: parseUsage(r.usage),
    errorCount: r.error_count ?? 0,
  });

  const isLive = (r: SessionRowLite): boolean => {
    if (watchers.has(r.id)) return true;
    if (!r.ended_at) return false;
    const ended = Date.parse(r.ended_at);
    return Number.isFinite(ended) && now - ended < LIVE_WINDOW_MS;
  };

  const live: ActivitySessionLite[] = [];
  const recent: ActivitySessionLite[] = [];
  for (const r of rows) {
    if (isLive(r)) {
      if (live.length < LIVE_CAP) live.push(toLite(r, true));
    } else if (r.ended_at && r.ended_at >= since && recent.length < RECENT_CAP) {
      recent.push(toLite(r, false));
    }
  }

  // ---- Burn ----
  const rangeMs = days != null ? days * DAY : null;
  // rangeSpendTokensByModel (Task 2, the P0 fix): ranged billed cells from
  // bucketedUsage (day-bucketed, not rangedUsage), NOT sumRange's raw
  // `s.started_at >= cutoff` sum — a session that started before the range but ran INTO
  // it (e.g. spans midnight into "Today") used to vanish from this sum entirely;
  // bucketedUsage instead attributes its in-range share, split by LOCAL day so the client
  // can price a window straddling a rate change (e.g. Sonnet 5's intro window) correctly.
  // The token range is already null for "All" (extends-to-now semantics match
  // bucketedUsage's cutoffIso===null "All range" signal exactly).
  const bucketedCells = bucketedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso, 'day');
  const rangeSpendTokensByModel: UsageByModel = {};
  const rangeSpendTokensByModelByDay: Record<string, UsageByModel> = {};
  for (const c of bucketedCells) {
    addCellInto(rangeSpendTokensByModel, c.model, c.cells);
    const dayAcc = rangeSpendTokensByModelByDay[c.bucket] ?? (rangeSpendTokensByModelByDay[c.bucket] = {});
    addCellInto(dayAcc, c.model, c.cells);
  }

  let baselineTokensByModel: UsageByModel;
  if (days != null && days <= 1) {
    baselineTokensByModel = medianBaseline(q);                           // Today → 14-day daily median
  } else if (rangeMs != null) {
    const priorFrom = new Date(now - 2 * rangeMs).toISOString();
    const priorTo = new Date(now - rangeMs).toISOString();
    baselineTokensByModel = sumRange(q, priorFrom, priorTo);           // Nd → prior-Nd totals
  } else {
    baselineTokensByModel = {};                                        // no window (All) → no baseline
  }

  // Top session in the window by total tokens (price-free proxy — see header).
  // overlapGate: a session that overlaps the window is a valid top-session
  // candidate even if it started before the cutoff (same P0 fix as rangeSpendTokensByModel
  // above) — ranking still uses the session's full raw usage as the magnitude proxy (not
  // scaled to its in-range share), matching this block's pre-existing "price-free proxy"
  // approximation.
  const winWhere = q.sessionRows;
  const winRows = db.prepare(
    `SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
            s.started_at, s.ended_at, s.usage, s.error_count
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE ${winWhere.sql}`,
  ).all(...winWhere.params) as unknown as SessionRowLite[];
  let top: { row: SessionRowLite; cells: UsageByModel; tokens: number } | null = null;
  for (const r of winRows) {
    const cells = parseUsage(r.usage);
    const tokens = totalTokens(cells);
    if (tokens > 0 && (!top || tokens > top.tokens)) top = { row: r, cells, tokens };
  }

  // ---- Anomaly cells ----
  // Cover the FULL range PLUS MEDIAN_DAYS of prior history, so (a) per-day flags
  // near the window start still have a trailing median and (b) the window SUM is
  // complete for every window. The old `Math.min(days ?? 30, 90)` cap made "All"
  // reach back only 44 days while 90d reached 104 — so the window total and
  // flagged-day count came out SMALLER for All than for 90d: a monotonicity
  // bug. A bounded window reaches back `days + MEDIAN_DAYS`; "All"
  // (days == null) has no cutoff so it spans every day of history.
  const anomalyRange = rangeOf(days != null ? days + MEDIAN_DAYS : null, now);
  const projName = new Map<number, string>();
  for (const r of db.prepare('SELECT id, name FROM projects').all() as unknown as { id: number; name: string }[]) projName.set(r.id, r.name);
  const anomDayMap = new Map<string, AnomalyDayCells>();
  for (const c of bucketedUsage(db, q.where.sql, q.where.params, anomalyRange.cutoffIso, 'day')) {
    let d = anomDayMap.get(c.bucket);
    if (!d) { d = { day: c.bucket, byModel: {}, byProject: {}, bySource: {} }; anomDayMap.set(c.bucket, d); }
    addCellInto(d.byModel, c.model, c.cells);
    const pk = projName.get(c.projectId) ?? String(c.projectId);
    addCellInto(d.byProject[pk] ?? (d.byProject[pk] = {}), c.model, c.cells);
    addCellInto(d.bySource[c.source] ?? (d.bySource[c.source] = {}), c.model, c.cells);
  }
  const anomalyDays = [...anomDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  const today = localDayKey(new Date(now));

  return {
    live,
    recent,
    burn: {
      rangeSpendTokensByModel,
      rangeSpendTokensByModelByDay,
      baselineTokensByModel,
      topSessionId: top?.row.id ?? null,
      topSessionName: top ? sessionDisplayName(top.row, 'id') : null,
      topSessionTokensByModel: top?.cells ?? {},
      anomalyDays,
      today,
    },
  };
}
