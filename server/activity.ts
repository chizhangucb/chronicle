// Home dashboard data engine (Task 13, spec §2.1). Backs the Activity block
// (live rows + since-you-left rows) and the Burn tile (current-window spend vs
// a baseline) on the `/` dashboard. Mirrors server/insights.ts patterns: the
// COALESCE(minor,0)=0 gate on aggregates, a `days=` window cutoff, and reading
// token MAGNITUDE from the authoritative per-session `sessions.usage` blob (the
// same source Insights/Explore price from) rather than per-message columns.
//
// PRICE TABLE STAYS CLIENT-SIDE (hard constraint): every token figure is
// returned as per-model token CELLS (the shape of a `sessions.usage` entry);
// the client prices them via src/models.ts `costOf`. The server never computes
// dollars — including "top session", which it picks by total tokens (a
// price-free proxy) and returns with its cells so the client can price it.
import { db } from './db.ts';
import { liveWatcherSessionIds } from './live.ts';
import { overlapGate, bucketedUsage } from './windowUsage.ts';
import { isSyntheticUserText } from '../shared/synthetic.ts';

const DAY = 86400000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const LIVE_CAP = 6;
const RECENT_CAP = 10;
// The trailing complete-days window the "Today" burn baseline medians over.
const MEDIAN_DAYS = 14;

// Per-model token cell — the shape of a `sessions.usage` entry, normalized so
// the client's costOf reads it directly (legacy `cacheWrite` folded to 5m).
export interface TokenCell {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export type TokensByModel = Record<string, TokenCell>;

export interface ActivitySessionLite {
  id: string;
  name: string;              // resolved display name (name → summary → first_prompt → id)
  projectName: string;
  source: string;
  live: boolean;
  endedAt: string | null;
  tokensByModel: TokensByModel;  // client prices via costOf
  errorCount: number;
}

export interface ActivityBurn {
  windowSpendTokensByModel: TokensByModel;
  // Day-bucketed (LOCAL calendar day, CHI-228) breakdown of windowSpendTokensByModel —
  // lets the client price the Burn tile's current-window spend per day at that day's
  // rate (e.g. Sonnet 5's intro window) instead of one flat rate for the whole window.
  // This is the figure CHI-227's audit found overstated ~50% during the intro window, so
  // it's the one burn.* field worth day-bucketing; baselineTokensByModel/
  // topSessionTokensByModel stay flat (see their own comments below for why).
  windowSpendTokensByModelByDay: Record<string, TokensByModel>;
  // Today → 14-day daily median (a statistical "typical day" construct with no single
  // real date to price at); Nd → prior-Nd totals (a comparison anchor, not the live spend
  // figure this fix targets — deliberately left flat, see server/activity.ts CHI-228 note).
  baselineTokensByModel: TokensByModel;
  topSessionId: string | null;
  topSessionName: string | null;
  // Price-free-proxy magnitude (see header) — left flat/unscaled by the same existing
  // design as the rest of this field, day-bucketing not attempted for one session's usage.
  topSessionTokensByModel: TokensByModel;
  // CHI-324 2c: per-day per-dimension token CELLS over a lookback window, so the
  // client can price (at the toggled mode) → CostedDay[] → the shared
  // computeAnomaly (movers + flagged days). Server ships cells, not dollars.
  anomalyDays: AnomalyDayCells[];
  // LOCAL "today" key (YYYY-MM-DD), the anchor computeAnomaly compares against.
  today: string;
}

// One day's per-dimension token cells (dollars are priced client-side). project
// is keyed by NAME for display; movers cover project/model/source (exact from
// sessions.usage). skill/agent/mcp movers are a later refinement (calibrated).
export interface AnomalyDayCells {
  day: string;
  byModel: TokensByModel;
  byProject: Record<string, TokensByModel>;
  bySource: Record<string, TokensByModel>;
}

export interface ActivityResult {
  live: ActivitySessionLite[];
  recent: ActivitySessionLite[];
  burn: ActivityBurn;
}

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

// Exported so other engines can align their own session-name fallback with
// this one instead of re-deriving it (explore.ts's group=session label uses
// this exact precedence — see server/explore.ts). Typed against the minimal
// field set rather than SessionRowLite so callers with a narrower row shape
// (e.g. an id/name/summary/first_prompt-only query) can pass it directly.
export interface NamedSessionRow { id: string; name: string | null; summary: string | null; first_prompt: string | null; }
export function displayName(r: NamedSessionRow): string {
  // Read-path guard (CHI-368): a first_prompt that is a synthetic wrapper (command
  // echo / cross-session IPC) is treated as absent, so a session imported BEFORE
  // the parser fix still never shows a raw `<…>` wrapper — it falls through to the
  // summary or the id. Fresh imports already store a clean first_prompt.
  const fp = r.first_prompt && !isSyntheticUserText(r.first_prompt) ? r.first_prompt : null;
  return r.name || r.summary || fp || r.id;
}

// Parse a `sessions.usage` blob into normalized cells (legacy `cacheWrite`
// → cacheWrite5m, matching src/models.ts costOf's own fallback).
function parseUsage(json: string | null): TokensByModel {
  if (!json) return {};
  let raw: Record<string, Record<string, number | null | undefined>>;
  try { raw = JSON.parse(json); } catch { return {}; }
  const out: TokensByModel = {};
  for (const [model, u] of Object.entries(raw)) {
    if (!u || typeof u !== 'object') continue;
    out[model] = {
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheWrite5m: (u.cacheWrite5m ?? u.cacheWrite ?? 0) || 0,
      cacheWrite1h: u.cacheWrite1h || 0,
    };
  }
  return out;
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

function emptyCell(): TokenCell {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

// Merge a session's cells into an accumulator (per-model, per-field sum).
function addUsage(acc: TokensByModel, cells: TokensByModel): void {
  for (const [model, cell] of Object.entries(cells)) {
    const cur = acc[model] ?? (acc[model] = emptyCell());
    for (const f of FIELDS) cur[f] += cell[f];
  }
}

function cellTotal(cell: TokenCell): number {
  let n = 0;
  for (const f of FIELDS) n += cell[f];
  return n;
}
function totalTokens(cells: TokensByModel): number {
  let n = 0;
  for (const cell of Object.values(cells)) n += cellTotal(cell);
  return n;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Sum per-session usage over a started_at window [from, to) (either bound may
// be null = unbounded), respecting the minor gate.
function sumWindow(from: string | null, to: string | null): TokensByModel {
  const where = ['COALESCE(s.minor,0)=0'];
  const params: string[] = [];
  if (from != null) { where.push('s.started_at >= ?'); params.push(from); }
  if (to != null) { where.push('s.started_at < ?'); params.push(to); }
  const rows = db.prepare(
    `SELECT s.usage FROM sessions s WHERE ${where.join(' AND ')}`,
  ).all(...params) as unknown as { usage: string | null }[];
  const acc: TokensByModel = {};
  for (const r of rows) addUsage(acc, parseUsage(r.usage));
  return acc;
}

// Median of the trailing MEDIAN_DAYS COMPLETE UTC calendar days' per-model
// daily token totals. Each field is medianed independently across the 14 days
// (missing days count as 0), yielding a priceable "typical day" cell per model
// — the client prices it for the baseline spend figure.
function medianBaseline(now: number): TokensByModel {
  const nowDate = new Date(now);
  const todayMidnight = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const dayStr = (d: number) => new Date(todayMidnight - d * DAY).toISOString().slice(0, 10);
  const from = dayStr(MEDIAN_DAYS);                       // 14 complete days ago
  const to = new Date(todayMidnight).toISOString();       // exclusive: today's midnight

  const rows = db.prepare(
    `SELECT substr(s.started_at,1,10) AS day, s.usage
     FROM sessions s
     WHERE COALESCE(s.minor,0)=0 AND s.started_at >= ? AND s.started_at < ?`,
  ).all(from, to) as unknown as { day: string; usage: string | null }[];

  // day → model → summed cell
  const byDay = new Map<string, TokensByModel>();
  for (const r of rows) {
    const acc = byDay.get(r.day) ?? {};
    addUsage(acc, parseUsage(r.usage));
    byDay.set(r.day, acc);
  }
  const days = Array.from({ length: MEDIAN_DAYS }, (_, i) => dayStr(i + 1)); // d=1..14
  const models = new Set<string>();
  for (const m of byDay.values()) for (const model of Object.keys(m)) models.add(model);

  const out: TokensByModel = {};
  for (const model of models) {
    const cell = emptyCell();
    for (const f of FIELDS) {
      cell[f] = median(days.map((day) => byDay.get(day)?.[model]?.[f] ?? 0));
    }
    out[model] = cell;
  }
  return out;
}

// `nowMs` is the wall clock the window/live/baseline math reads. It defaults to
// Date.now() (production); a caller can pin it so a test is not coupled to the
// real time of day (CHI-389: the "Today" window is only minutes wide just after
// UTC midnight, which the fixtures cannot represent).
export function computeActivity(sinceIso: string | null, days: number | null, nowMs: number = Date.now()): ActivityResult {
  const now = nowMs;
  // since defaults to a trailing 12h window (see task brief).
  const since = sinceIso && !Number.isNaN(Date.parse(sinceIso)) ? sinceIso : new Date(now - 12 * 3600000).toISOString();
  const watchers = liveWatcherSessionIds();

  const rows = db.prepare(
    `SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
            s.started_at, s.ended_at, s.usage, s.error_count
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE COALESCE(s.minor,0)=0
     ORDER BY COALESCE(s.ended_at, s.started_at) DESC
     LIMIT 100`,
  ).all() as unknown as SessionRowLite[];

  const toLite = (r: SessionRowLite, live: boolean): ActivitySessionLite => ({
    id: r.id,
    name: displayName(r),
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
  const windowMs = days != null ? days * DAY : null;
  const windowCutoff = windowMs != null ? new Date(now - windowMs).toISOString() : null;
  // windowSpendTokensByModel (Task 2, the P0 fix): windowed billed cells from
  // bucketedUsage (CHI-228: day-bucketed, was windowedUsage), NOT sumWindow's raw
  // `s.started_at >= cutoff` sum — a session that started before the window but ran INTO
  // it (e.g. spans midnight into "Today") used to vanish from this sum entirely;
  // bucketedUsage instead attributes its in-window share, split by LOCAL day so the client
  // can price a window straddling a rate change (e.g. Sonnet 5's intro window) correctly.
  // windowCutoff is already null for "All" (extends-to-now semantics match bucketedUsage's
  // cutoffIso===null "All window" signal exactly), so no extra mapping is needed.
  const bucketedCells = bucketedUsage(db, 'AND COALESCE(s.minor,0)=0', [], windowCutoff, 'day');
  const windowSpendTokensByModel: TokensByModel = {};
  const windowSpendTokensByModelByDay: Record<string, TokensByModel> = {};
  for (const c of bucketedCells) {
    addUsage(windowSpendTokensByModel, { [c.model]: c.cells });
    const dayAcc = windowSpendTokensByModelByDay[c.bucket] ?? (windowSpendTokensByModelByDay[c.bucket] = {});
    addUsage(dayAcc, { [c.model]: c.cells });
  }

  let baselineTokensByModel: TokensByModel;
  if (days != null && days <= 1) {
    baselineTokensByModel = medianBaseline(now);                       // Today → 14-day daily median
  } else if (windowMs != null) {
    const priorFrom = new Date(now - 2 * windowMs).toISOString();
    const priorTo = new Date(now - windowMs).toISOString();
    baselineTokensByModel = sumWindow(priorFrom, priorTo);             // Nd → prior-Nd totals
  } else {
    baselineTokensByModel = {};                                        // no window (All) → no baseline
  }

  // Top session in the window by total tokens (price-free proxy — see header).
  // overlapGate (Task 2): a session that overlaps the window is a valid top-session
  // candidate even if it started before the cutoff (same P0 fix as windowSpendTokensByModel
  // above) — ranking still uses the session's full raw usage as the magnitude proxy (not
  // scaled to its in-window share), matching this block's pre-existing "price-free proxy"
  // approximation.
  const winRows = db.prepare(
    `SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
            s.started_at, s.ended_at, s.usage, s.error_count
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE COALESCE(s.minor,0)=0${windowCutoff != null ? ` AND ${overlapGate('s')}` : ''}`,
  ).all(...(windowCutoff != null ? [windowCutoff] : [])) as unknown as SessionRowLite[];
  let top: { row: SessionRowLite; cells: TokensByModel; tokens: number } | null = null;
  for (const r of winRows) {
    const cells = parseUsage(r.usage);
    const tokens = totalTokens(cells);
    if (tokens > 0 && (!top || tokens > top.tokens)) top = { row: r, cells, tokens };
  }

  // ---- Anomaly cells (CHI-324 2c) ----
  // Cover the FULL window PLUS MEDIAN_DAYS of prior history, so (a) per-day flags
  // near the window start still have a trailing median and (b) the window SUM is
  // complete for every window. The old `Math.min(days ?? 30, 90)` cap made "All"
  // reach back only 44 days while 90d reached 104 — so the window total and
  // flagged-day count came out SMALLER for All than for 90d (a monotonicity bug,
  // CHI-324 review). A bounded window reaches back `days + MEDIAN_DAYS`; "All"
  // (days == null) has no cutoff so it spans every day of history.
  const anomalyCutoff = days != null ? new Date(now - (days + MEDIAN_DAYS) * DAY).toISOString() : null;
  const projName = new Map<number, string>();
  for (const r of db.prepare('SELECT id, name FROM projects').all() as unknown as { id: number; name: string }[]) projName.set(r.id, r.name);
  const anomDayMap = new Map<string, AnomalyDayCells>();
  for (const c of bucketedUsage(db, 'AND COALESCE(s.minor,0)=0', [], anomalyCutoff, 'day')) {
    let d = anomDayMap.get(c.bucket);
    if (!d) { d = { day: c.bucket, byModel: {}, byProject: {}, bySource: {} }; anomDayMap.set(c.bucket, d); }
    addUsage(d.byModel, { [c.model]: c.cells });
    const pk = projName.get(c.projectId) ?? String(c.projectId);
    addUsage(d.byProject[pk] ?? (d.byProject[pk] = {}), { [c.model]: c.cells });
    addUsage(d.bySource[c.source] ?? (d.bySource[c.source] = {}), { [c.model]: c.cells });
  }
  const anomalyDays = [...anomDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  const nowD = new Date(now);
  const today = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;

  return {
    live,
    recent,
    burn: {
      windowSpendTokensByModel,
      windowSpendTokensByModelByDay,
      baselineTokensByModel,
      topSessionId: top?.row.id ?? null,
      topSessionName: top ? displayName(top.row) : null,
      topSessionTokensByModel: top?.cells ?? {},
      anomalyDays,
      today,
    },
  };
}
