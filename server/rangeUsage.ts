// server/rangeUsage.ts
// Windowed-usage primitive (feedback-round plan, "Global constraints" §Windowed-usage
// semantics): a session belongs to a time window iff its activity span
// [started_at, COALESCE(ended_at, started_at)] overlaps the window — NOT the old
// `COALESCE(s.started_at,'9') >= cutoff` gate every engine route used, which drops a
// session that started before the range but ran INTO it (root defect this task fixes;
// Task 2 wires this module into insights.ts/explore.ts/content.ts/routes/projects.ts/
// routes/activity.ts).
//
// Billed magnitudes (`sessions.usage`) are attributed to a window via per-session,
// per-model calibration: scale each billed cell by
// (in-range per-message tokens ÷ whole-session per-message tokens), clamped 0..1 — the
// SAME "share of a real total" idea server/calibrate.ts uses, just weighted by token
// count instead of text length. Sessions fully inside the window naturally get ratio 1
// (in-range sum == whole-session sum). A model with ZERO per-message rows in the
// session (so there's no signal to compute a ratio from) falls back to its FULL billed
// cell — the session already overlaps the window, by construction of the caller
// (overlapGate already filtered it in).
//
// Framework-free by design: callers (server/insights.ts, explore.ts, content.ts,
// routes/projects.ts, routes/activity.ts) supply the `db` handle, a scope WHERE
// fragment (typically `server/scope.ts`'s scopeClause + minorGate output, ANDed onto
// the query) and its binds. This module never imports scope.ts, so it stays testable
// standalone with a bare in-memory-style temp DB.
import type { DatabaseSync } from 'node:sqlite';

export interface UsageCells {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface RangeUsageCell {
  sessionId: string;
  projectId: number;
  model: string;
  source: string;
  cells: UsageCells;
}

export type UsageBucket = 'hour' | 'day';

export interface BucketedUsageCell extends RangeUsageCell {
  bucket: string;
}

// Replaces the old `COALESCE(s.started_at,'9') >= ?` session-start gate: a session
// whose activity ran INTO the window counts, even if it started earlier — windows
// always extend to "now", so overlap reduces to "did this session's last known
// activity happen on or after the cutoff". Returns the bare comparison (no leading
// `AND`), matching how the old pattern was spliced directly after `WHERE`.
export function overlapGate(alias: string): string {
  return `COALESCE(${alias}.ended_at, ${alias}.started_at, '9') >= ?`;
}

// ---- sessions.usage parsing ----
// Mirrors server/explore.ts's parseUsageCells, but keyed by the long field names this
// module's callers (and its RangeUsageCell contract) use.
interface RawUsageCell {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWrite?: number; // legacy pre-TTL-split shape, billed at the 5m rate
}

function parseUsage(usage: string | null): Record<string, UsageCells> {
  if (!usage) return {};
  let parsed: Record<string, RawUsageCell>;
  try {
    parsed = JSON.parse(usage) as Record<string, RawUsageCell>;
  } catch {
    return {};
  }
  const out: Record<string, UsageCells> = {};
  for (const [model, u] of Object.entries(parsed)) {
    if (!u || typeof u !== 'object') continue;
    out[model] = {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite5m: u.cacheWrite5m ?? u.cacheWrite ?? 0,
      cacheWrite1h: u.cacheWrite1h ?? 0,
    };
  }
  return out;
}

function scaleCell(cell: UsageCells, ratio: number): UsageCells {
  return {
    input: Math.round(cell.input * ratio),
    output: Math.round(cell.output * ratio),
    cacheRead: Math.round(cell.cacheRead * ratio),
    cacheWrite5m: Math.round(cell.cacheWrite5m * ratio),
    cacheWrite1h: Math.round(cell.cacheWrite1h * ratio),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Local-time bucket key for a fallback (zero-message-row) session, derived from
// `started_at` via JS Date's local getters instead of a SQL `strftime(...,'localtime')`
// round trip — both read the OS timezone, so the two stay in step, and this avoids a
// query just for one row.
function localBucketKeyFromIso(iso: string, bucket: UsageBucket): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return bucket === 'day' ? `${y}-${mo}-${day}` : `${y}-${mo}-${day}T${pad2(d.getHours())}`;
}

// SQL local-time bucket key expression for a timestamp column — format matches
// localBucketKeyFromIso exactly (day: 'YYYY-MM-DD', hour: 'YYYY-MM-DDTHH').
function bucketKeyExpr(bucket: UsageBucket, column: string): string {
  return bucket === 'day'
    ? `strftime('%Y-%m-%d', ${column}, 'localtime')`
    : `strftime('%Y-%m-%dT%H', ${column}, 'localtime')`;
}

interface SessionUsageRow {
  sessionId: string;
  projectId: number;
  source: string;
  usage: string | null;
  startedAt: string | null;
}

function loadSessions(db: DatabaseSync, whereSql: string, binds: (string | number)[]): SessionUsageRow[] {
  return db.prepare(`
    SELECT s.id AS sessionId, s.project_id AS projectId, s.source AS source, s.usage AS usage, s.started_at AS startedAt
    FROM sessions s
    WHERE ${whereSql}
  `).all(...binds) as unknown as SessionUsageRow[];
}

// Combined (all-field) per-message token total per (session, model). The scale factor
// is ONE ratio per model (Global constraints), applied alike to every field of that
// model's billed cell, so the ratio math only ever needs a single combined number, not
// a per-field breakdown.
const TOKEN_SUM_EXPR = `(
  COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_read_tokens,0) +
  COALESCE(m.cache_w5m_tokens,0) + COALESCE(m.cache_w1h_tokens,0)
)`;
const TOTAL_EXPR = `COALESCE(SUM(${TOKEN_SUM_EXPR}),0)`;

interface WholeRangeRow { sessionId: string; model: string; whole: number; windowed: number; }

// Loads BOTH the whole-session and in-range combined totals per (session, model) from
// ONE scan of `messages` (conditional aggregation: the in-range column is a `SUM(CASE
// WHEN m.ts >= ? THEN ... ELSE 0 END)` alongside the unconditional whole-session SUM in
// the same GROUP BY s.id, model query) — not two separate CROSS JOIN queries differing
// only by an added `m.ts >= ?` filter, which would scan `messages` twice for the exact
// same rows.
function loadWholeAndRangeTotals(db: DatabaseSync, sql: string, binds: (string | number)[]): Map<string, Map<string, WholeRangeRow>> {
  const rows = db.prepare(sql).all(...binds) as unknown as WholeRangeRow[];
  const out = new Map<string, Map<string, WholeRangeRow>>();
  for (const r of rows) {
    let inner = out.get(r.sessionId);
    if (!inner) { inner = new Map(); out.set(r.sessionId, inner); }
    inner.set(r.model, r);
  }
  return out;
}

interface WholeBucketRow { sessionId: string; model: string; bucket: string | null; total: number; }

// Same one-scan idea as loadWholeAndRangeTotals, generalized to buckets: the bucket key
// expression is wrapped in `CASE WHEN m.ts >= ? THEN <bucketExpr> END`, so an
// out-of-window message's row lands in one NULL-bucket group per (session, model)
// instead of a real bucket. That NULL-bucket row's total still feeds the whole-session
// denominator (`whole`, summed across ALL groups incl. the NULL one below) but is
// skipped when building the per-bucket map — so one scan yields both the ratio
// denominator AND the per-bucket numerators, instead of a separate whole-sums query plus
// a separate bucketed-sums query.
function loadWholeAndBucketedTotals(db: DatabaseSync, sql: string, binds: (string | number)[]): {
  whole: Map<string, Map<string, number>>;
  buckets: Map<string, Map<string, Map<string, number>>>;
} {
  const rows = db.prepare(sql).all(...binds) as unknown as WholeBucketRow[];
  const whole = new Map<string, Map<string, number>>();
  const buckets = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    let wInner = whole.get(r.sessionId);
    if (!wInner) { wInner = new Map(); whole.set(r.sessionId, wInner); }
    wInner.set(r.model, (wInner.get(r.model) ?? 0) + r.total);
    if (r.bucket == null) continue; // out-of-window group: counted above, no bucket to attribute to
    let bBySession = buckets.get(r.sessionId);
    if (!bBySession) { bBySession = new Map(); buckets.set(r.sessionId, bBySession); }
    let bByModel = bBySession.get(r.model);
    if (!bByModel) { bByModel = new Map(); bBySession.set(r.model, bByModel); }
    bByModel.set(r.bucket, r.total);
  }
  return { whole, buckets };
}

// Per-session per-model in-range billed token cells. `scopeWhere`/`binds` are a
// caller-supplied WHERE fragment (ANDed onto the query, e.g. `server/scope.ts`'s
// scopeClause + minorGate output) plus its binds — this module stays scope-agnostic on
// purpose so it never needs to import scope.ts.
export function rangedUsage(
  db: DatabaseSync,
  scopeWhere: string,
  binds: (string | number)[],
  cutoffIso: string | null,
): RangeUsageCell[] {
  if (cutoffIso == null) {
    // All range: no time filter at all, so sessions.usage IS the in-range total —
    // parse it directly rather than paying for a message-table scan whose ratio would
    // only ever resolve back to exactly 1.
    const sessions = loadSessions(db, `1=1 ${scopeWhere}`, binds);
    const out: RangeUsageCell[] = [];
    for (const s of sessions) {
      for (const [model, cells] of Object.entries(parseUsage(s.usage))) {
        out.push({ sessionId: s.sessionId, projectId: s.projectId, model, source: s.source, cells });
      }
    }
    return out;
  }

  const whereSql = `${overlapGate('s')} ${scopeWhere}`;
  const whereBinds = [cutoffIso, ...binds];
  const sessions = loadSessions(db, whereSql, whereBinds);
  if (sessions.length === 0) return [];

  // ONE pass over `messages` (mirrors server/insights.ts: `sessions CROSS JOIN messages`
  // so idx_messages_agg(session_id, kind, ts, tool_name, model) serves the scan): the
  // whole-session and in-range totals are two columns of the SAME conditionally-
  // aggregated query, not two separate CROSS JOIN scans differing only by an added
  // `m.ts >= ?` filter — never a per-session query loop either way.
  const totals = loadWholeAndRangeTotals(db, `
    SELECT s.id AS sessionId, COALESCE(m.model,'') AS model,
      ${TOTAL_EXPR} AS whole,
      COALESCE(SUM(CASE WHEN m.ts >= ? THEN ${TOKEN_SUM_EXPR} ELSE 0 END),0) AS windowed
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${whereSql}
    GROUP BY s.id, model
  `, [cutoffIso, ...whereBinds]);

  const out: RangeUsageCell[] = [];
  for (const s of sessions) {
    for (const [model, cell] of Object.entries(parseUsage(s.usage))) {
      const t = totals.get(s.sessionId)?.get(model);
      // No per-message rows (or they all summed to zero) → no signal to scale from:
      // fall back to the model's full billed cell. The session already overlaps the
      // window (loadSessions filtered on overlapGate above), so this is not an
      // overcount — it's the Global constraints fallback rule.
      const ratio = !t || !t.whole ? 1 : Math.max(0, Math.min(1, t.windowed / t.whole));
      out.push({ sessionId: s.sessionId, projectId: s.projectId, model, source: s.source, cells: scaleCell(cell, ratio) });
    }
  }
  return out;
}

// Same cells as rangedUsage, additionally split across LOCAL-time buckets in
// proportion to each bucket's share of the model's WHOLE-session per-message total (not
// its in-range total) — summing a session-model's bucketed cells back together
// reproduces rangedUsage's own scaled cell for that session-model (up to per-bucket
// rounding drift, same caveat calibrateByBucket has). A `cutoffIso` of null buckets the
// session's entire history (there is no window to restrict to); every real caller
// (insights.ts's dailySpend/hourlySpend, Task 2) passes a real cutoff.
export function bucketedUsage(
  db: DatabaseSync,
  scopeWhere: string,
  binds: (string | number)[],
  cutoffIso: string | null,
  bucket: UsageBucket,
): BucketedUsageCell[] {
  const effectiveCutoff = cutoffIso ?? '';
  const whereSql = `${overlapGate('s')} ${scopeWhere}`;
  const whereBinds = [effectiveCutoff, ...binds];
  const sessions = loadSessions(db, whereSql, whereBinds);
  if (sessions.length === 0) return [];

  // ONE pass over `messages`: the bucket key is `CASE WHEN m.ts >= ? THEN <bucketExpr>
  // END`, so an out-of-window message's row collapses into a single NULL-bucket group
  // per (session, model) instead of a real bucket — its total still feeds the
  // whole-session ratio denominator (loadWholeAndBucketedTotals sums it into `whole`)
  // but is excluded from the per-bucket map. No separate whole-sums query needed.
  const bucketExpr = bucketKeyExpr(bucket, 'm.ts');
  const { whole, buckets } = loadWholeAndBucketedTotals(db, `
    SELECT s.id AS sessionId, COALESCE(m.model,'') AS model,
      CASE WHEN m.ts >= ? THEN ${bucketExpr} END AS bucket,
      ${TOTAL_EXPR} AS total
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${whereSql}
    GROUP BY s.id, model, bucket
  `, [effectiveCutoff, ...whereBinds]);

  const out: BucketedUsageCell[] = [];
  for (const s of sessions) {
    for (const [model, cell] of Object.entries(parseUsage(s.usage))) {
      const wholeTotal = whole.get(s.sessionId)?.get(model);
      if (!wholeTotal) {
        // Fallback: no per-message rows to bucket by — the whole billed cell lands on
        // the session's own started_at-derived local bucket. Without a started_at
        // there's no basis for a bucket key at all (sessions always carry one in
        // practice); skip rather than inventing a placeholder key.
        if (!s.startedAt) continue;
        out.push({
          sessionId: s.sessionId, projectId: s.projectId, model, source: s.source,
          bucket: localBucketKeyFromIso(s.startedAt, bucket), cells: cell,
        });
        continue;
      }
      const perBucket = buckets.get(s.sessionId)?.get(model);
      if (!perBucket) continue; // whole>0 but nothing fell in-range: no bucket to attribute to
      for (const [bkey, bsum] of perBucket) {
        const ratio = Math.max(0, Math.min(1, bsum / wholeTotal));
        out.push({ sessionId: s.sessionId, projectId: s.projectId, model, source: s.source, bucket: bkey, cells: scaleCell(cell, ratio) });
      }
    }
  }
  return out;
}
