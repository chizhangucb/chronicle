// The analytics engine behind the Insights home AND the project page (#305).
//
// The four scoped aggregates (tool distribution, kind distribution, activity
// and errors) plus the ranged billed cells are computed HERE, once, from the
// one query context: scope clause, minor gate, session/message/token ranges,
// see server/scope.ts. `computeInsights` runs them at whatever scope the home
// is looking at; `computeScopedAggregates` is the same aggregates for one
// project, which is all server/routes/projects.ts keeps beyond its session list
// and its Git data. Scoping Insights to a project and opening that project
// therefore report the same numbers, because there is nothing left to disagree.
// Error counts read the per-session
// result_count/error_count columns precomputed at import with the
// shared/errors.ts heuristic, the same one the client runs over a live session.
//
// `dailyActivity`/`hourlyActivity` are DELIBERATELY exempt from the `days=`
// filter — Working Rhythm (src/insights/WorkingRhythm.tsx) always shows a
// fixed trailing 182-day calendar heatmap and a fixed trailing 30-day
// hour-of-day heatmap, independent of the page's range control.
import { db } from './db.ts';
import { commitCountSinceAsync } from './git.ts';
import { bucketedUsage, type BucketedUsageCell } from './rangeUsage.ts';
import { queryContext, tsNotNull, whereOf, type QueryContext, type Range, type Scope, type SqlFragment } from './scope.ts';

export interface InsightsSessionRow {
  id: string;
  project_id: number;
  project_name: string;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  agent_active_ms: number | null;
  engaged_ms: number | null;
  context_tokens: number | null;
  usage: string | null;
}

export interface InsightsResult {
  sessions: InsightsSessionRow[];
  toolDist: ToolCount[];
  kindDist: KindCount[];
  modelDist: { model: string; count: number }[];
  // Fixed 30-day-trailing model distribution — same window as
  // hourlyActivity (see HOURLY_WINDOW_DAYS below), NOT the `days=` cutoff.
  // Working Rhythm's "Favorite model" stat reads this instead of `modelDist`
  // so it stays in step with its card-mates (Active days/streaks/Peak hour),
  // which all use the same fixed window and must not move when the page's
  // range control changes.
  modelDistFixed: { model: string; count: number }[];
  errors: number;
  errorsByProject: ProjectErrorCount[];
  commits: number;
  dailyActivity: DayCount[];
  hourlyActivity: { dow: number; hour: number; count: number }[];
  projects: { id: number; name: string }[];
  // Ranged billed cells (Task 2, feedback-round P0 fix): per-session,
  // per-model, per-LOCAL-day, in-range-scaled — the client (Task 3, with
  // day-aware pricing) prices these for the KPI strip / spend-by-model /
  // sources / top-sessions instead of summing raw `sessions.usage`, so a
  // session that started before the range but ran INTO it (the root defect
  // — see server/rangeUsage.ts) contributes its in-range share instead of
  // vanishing (old gate) or over-counting (naive overlap-only gate). Day-
  // bucketed so a session whose usage straddles a rate change (e.g.
  // Sonnet 5's intro window) prices each day's share at that day's rate.
  rangedTokensByModel: BucketedUsageCell[];
  // Same cells, additionally bucketed by LOCAL calendar day — feeds the
  // Today/7d/30d spend-over-time chart without a UTC/local double-shift.
  dailySpend: BucketedUsageCell[];
  // Same, bucketed by LOCAL hour-of-day — only meaningful (and only
  // computed) for a short window, so it's null unless days<=2 (Today or just
  // past it); the client falls back to dailySpend otherwise.
  hourlySpend: BucketedUsageCell[] | null;
}

// ---- The scoped aggregates (#305) ----
//
// Tool distribution, kind distribution, activity and errors, each written ONCE
// here and read by both surfaces: `computeInsights` below for the Insights
// home, `computeScopedAggregates` for the project page. Both take the query
// context (server/scope.ts), so "scoped" means the same thing on either call
// site: all projects, one project, or one session.
//
// Every message-level aggregate is written as `sessions CROSS JOIN messages`
// ON PURPOSE. CROSS JOIN pins sessions (a few hundred slim rows) as the outer
// loop, so messages are reached through the COVERING idx_messages_agg index
// (see db.ts) instead of a full scan of the fat messages table. That scan was
// the 0.1-3.6s-per-query (multi-second cold) cost behind every Insights range
// click.

export interface ToolCount { name: string; count: number }
export interface KindCount { kind: string; count: number }
export interface DayCount { day: string; count: number }
export interface ProjectErrorCount { project_id: number; head_count: number; error_count: number }

/** The four scoped aggregates plus the ranged billed cells: the whole of what
 * the project page reports beyond its session list and its Git data. */
export interface ScopedAggregates {
  toolDist: ToolCount[];
  kindDist: KindCount[];
  /** Message count per LOCAL calendar day, over the range. */
  activity: DayCount[];
  errors: number;
  rangedTokensByModel: BucketedUsageCell[];
}

const TOOL_DIST_LIMIT = 24;

function toolDistribution(q: QueryContext): ToolCount[] {
  const where = whereOf(q.messageRows, "AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL");
  return db.prepare(`
    SELECT m.tool_name AS name, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${where.sql}
    GROUP BY m.tool_name ORDER BY count DESC LIMIT ${TOOL_DIST_LIMIT}
  `).all(...where.params) as unknown as ToolCount[];
}

function kindDistribution(q: QueryContext): KindCount[] {
  const where = q.messageRows;
  return db.prepare(`
    SELECT m.kind AS kind, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${where.sql}
    GROUP BY m.kind
  `).all(...where.params) as unknown as KindCount[];
}

// Message count per LOCAL calendar day: a 'localtime' modifier on strftime,
// not a UTC substr of the ISO string, so "today" on a chart means the viewer's
// today. The caller composes the WHERE, because the two callers count over
// different spans: the project page passes the range-scoped message rows,
// Insights' Working Rhythm passes its fixed trailing calendar span (exempt
// from the range by design, see the file header). A day-keyed query drops a
// NULL `ts` outright: it has no day to be counted on.
function dailyMessageCounts(where: SqlFragment): DayCount[] {
  const w = whereOf(where, tsNotNull('m'));
  return db.prepare(`
    SELECT strftime('%Y-%m-%d', m.ts, 'localtime') AS day, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${w.sql}
    GROUP BY day ORDER BY day
  `).all(...w.params) as unknown as DayCount[];
}

// Error stats come from the per-session result_count/error_count columns
// precomputed at import (db.ts replaceSession plus a one-time backfill). The
// old shape pulled EVERY tool_result head (35k+ rows on the maintainer's real
// DB) into JS and regexed each one on every request: 0.8-17s per click.
// Session-level (no messages join), so only the session range applies here.
// There is no per-message ts to additionally restrict by.
//
// KNOWN RANGE TRADEOFF, unlike the token magnitudes, which bucketedUsage scales
// to an in-range share: error_count/result_count are WHOLE-SESSION precomputed
// totals (shared/errors.ts heuristic, backfilled once at import). The session
// range counts a session that ran INTO the range, correctly making it visible
// for "Today", but its error count here is its FULL historical count, not just
// today's errors. There is no per-message error timestamp to re-slice by on
// this fast path; that would mean joining messages and re-running the
// tool_result/tool_use MIN(id) pairing query per request, the exact
// per-request regex cost this precomputed-column path was built to avoid (see
// shared/errors.ts's header). Net effect: a long-running spanning session can
// OVER-count errors into a short range. The old behavior was worse: it was
// excluded and UNDER-counted, i.e. zero.
function errorTotals(q: QueryContext): { errors: number; errorsByProject: ProjectErrorCount[] } {
  const where = q.sessionRows;
  const errorsByProject = db.prepare(`
    SELECT s.project_id AS project_id,
           SUM(COALESCE(s.result_count, 0)) AS head_count,
           SUM(COALESCE(s.error_count, 0)) AS error_count
    FROM sessions s
    WHERE ${where.sql}
    GROUP BY s.project_id
  `).all(...where.params) as unknown as ProjectErrorCount[];
  return { errorsByProject, errors: errorsByProject.reduce((n, r) => n + r.error_count, 0) };
}

// Ranged billed cells: per-session, per-model, per-LOCAL-day, scaled to the
// in-range SHARE. bucketedUsage takes the context's scope plus minor fragment
// and its own token cutoff, and applies the session overlap internally. Day-
// bucketed (not the plain rangedUsage()) so the client can price each day's
// share at that day's rate, see InsightsResult's field comment.
function rangedTokens(q: QueryContext): BucketedUsageCell[] {
  return bucketedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso, 'day');
}

/**
 * The aggregates for one scope and range: what server/routes/projects.ts
 * serves as a project's analytics, and the same numbers Insights reports when
 * it is scoped to that project (#305).
 */
export function computeScopedAggregates(scope: Scope, range: Range): ScopedAggregates {
  const q = queryContext(scope, range);
  return {
    toolDist: toolDistribution(q),
    kindDist: kindDistribution(q),
    activity: dailyMessageCounts(q.messageRows),
    errors: errorTotals(q).errors,
    rangedTokensByModel: rangedTokens(q),
  };
}

const CALENDAR_WINDOW_DAYS = 182;
const HOURLY_WINDOW_DAYS = 30;

// Short-lived commit-count cache, keyed by `path::cutoff`. `computeInsights`
// used to shell out to `git rev-list --count` once per project, SERIALLY and
// SYNCHRONOUSLY, on every single request — including every 7d/30d/90d/All
// range-control click, blocking the whole server's event loop for the full
// duration each time (perf finding from the PR review). Two changes fix
// this: (1) the shell-outs below now run CONCURRENTLY via
// `commitCountSinceAsync` (libuv thread pool, not the main thread) instead
// of serially; (2) this cache means rapid successive requests for the same
// project+cutoff (e.g. clicking between range buttons and back within a few
// seconds) don't re-spawn git at all. Module-scope (this file is a singleton
// import, same lifetime as the process) — a real new commit becomes visible
// again once the short TTL expires, which is fine for an analytics KPI.
const COMMIT_CACHE_TTL_MS = 5 * 60_000;
const commitCache = new Map<string, { value: number; expiresAt: number }>();

async function cachedCommitCountSince(path: string, cutoff: string | null): Promise<number> {
  const key = `${path}::${cutoff ?? ''}`;
  const hit = commitCache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await commitCountSinceAsync(path, cutoff);
  commitCache.set(key, { value, expiresAt: now + COMMIT_CACHE_TTL_MS });
  return value;
}

// The fixed-window aggregates (dailyActivity/hourlyActivity/modelDistFixed)
// don't depend on `days=` at all, yet used to re-run on every range click —
// most of the remaining repeat-click latency after the index fix. Same
// short-TTL module-scope cache idea as the commit cache: minute-quantized
// cutoffs keep the key stable, so range clicks reuse the identical result.
const FIXED_CACHE_TTL_MS = 20_000;
let fixedCache: { key: string; value: Pick<InsightsResult, 'dailyActivity' | 'hourlyActivity' | 'modelDistFixed'>; expiresAt: number } | null = null;

export async function computeInsights(scope: Scope, range: Range): Promise<InsightsResult> {
  const q = queryContext(scope, range);
  const days = range.days;
  const nowMinute = Math.floor(range.now / 60000) * 60000;
  const calendarCutoff = new Date(nowMinute - CALENDAR_WINDOW_DAYS * 86400000).toISOString();
  const hourlyCutoff = new Date(nowMinute - HOURLY_WINDOW_DAYS * 86400000).toISOString();

  // The session range is OVERLAP (a session whose activity ran INTO the range
  // counts, not just one that STARTED in it), from the query context:
  // server/scope.ts.
  const sessionWhere = q.sessionRows;
  const sessions = db.prepare(`
    SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
           s.started_at, s.ended_at, s.message_count, s.agent_active_ms, s.engaged_ms, s.context_tokens, s.usage
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${sessionWhere.sql}
    ORDER BY s.started_at DESC
  `).all(...sessionWhere.params) as unknown as InsightsSessionRow[];

  // The scoped aggregates, from the one place they are written (above): the
  // project page reports the very same numbers by calling
  // computeScopedAggregates with its project scope.
  const toolDist = toolDistribution(q);
  const kindDist = kindDistribution(q);

  const modelWhere = whereOf(q.messageRows, "AND m.kind = 'assistant' AND m.model IS NOT NULL");
  const modelDist = db.prepare(`
    SELECT m.model AS model, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${modelWhere.sql}
    GROUP BY m.model ORDER BY count DESC
  `).all(...modelWhere.params) as unknown as { model: string; count: number }[];

  // Errors, from the same shared aggregate (see errorTotals above for the
  // precomputed-column fast path and its range tradeoff).
  const { errors, errorsByProject } = errorTotals(q);

  // Ranged billed cells (Task 2), see the InsightsResult field comments and
  // rangedTokens above. Bucketed usage is computed ONCE per request here:
  // dailySpend is the SAME day-bucketed cells under a second name (two fields
  // of the contract, one query) — recomputing it would scan `messages` twice
  // for identical rows. Neither field is mutated after this point; both are
  // read-only on the client and serialize identically.
  const rangedTokensByModel = rangedTokens(q);
  const dailySpend = rangedTokensByModel;
  const hourlySpend = days != null && days <= 2
    ? bucketedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso, 'hour')
    : null;

  // Fixed trailing windows — NOT filtered by `days=` (see file header).
  // Cached briefly (see fixedCache above) since they're identical across
  // range clicks; a fresh import becomes visible once the short TTL expires.
  const fixedKey = `${scope.type}:${scope.id ?? ''}::${calendarCutoff}::${hourlyCutoff}`;
  let fixed = fixedCache && fixedCache.key === fixedKey && fixedCache.expiresAt > Date.now() ? fixedCache.value : null;
  if (!fixed) {
    // The same day-bucketed message count the project page's `activity` is,
    // counted over the fixed trailing calendar span instead of the range (see
    // the file header): one query, two callers.
    const calendarWhere = whereOf({ sql: 'AND m.ts >= ?', params: [calendarCutoff] }, q.where);
    const dailyActivity = dailyMessageCounts(calendarWhere);

    const hourlyWhere = whereOf({ sql: 'AND m.ts >= ?', params: [hourlyCutoff] }, q.where);
    const hourlyActivity = db.prepare(`
      SELECT CAST(strftime('%w', m.ts, 'localtime') AS INTEGER) AS dow, CAST(strftime('%H', m.ts, 'localtime') AS INTEGER) AS hour, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE ${hourlyWhere.sql}
      GROUP BY dow, hour
    `).all(...hourlyWhere.params) as unknown as { dow: number; hour: number; count: number }[];

    const modelFixedWhere = whereOf({ sql: 'AND m.ts >= ?', params: [hourlyCutoff] }, q.where,
      "AND m.kind = 'assistant' AND m.model IS NOT NULL");
    const modelDistFixed = db.prepare(`
      SELECT m.model AS model, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE ${modelFixedWhere.sql}
      GROUP BY m.model ORDER BY count DESC
    `).all(...modelFixedWhere.params) as unknown as { model: string; count: number }[];
    fixed = { dailyActivity, hourlyActivity, modelDistFixed };
    fixedCache = { key: fixedKey, value: fixed, expiresAt: Date.now() + FIXED_CACHE_TTL_MS };
  }
  const { dailyActivity, hourlyActivity, modelDistFixed } = fixed;

  const projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all() as unknown as { id: number; name: string }[];

  // Concurrent (not serial) + cached — see the cache comment above. The
  // cache key is `path::cutoff`, and `cutoff` is derived from Date.now() with
  // MILLISECOND precision — as-is the key changed on every request, so the
  // cache NEVER hit and every range click re-spawned one `git rev-list` per
  // project (26 on the maintainer's machine). Quantizing the commit cutoff to
  // 5 minutes makes the key stable across the matching 5-min TTL, so revisiting
  // a range during a browsing session is a pure cache hit; the git window
  // boundary moves by at most 5min — irrelevant for a day-granular KPI.
  const commitCutoff = days ? new Date(Math.floor(range.now / COMMIT_CACHE_TTL_MS) * COMMIT_CACHE_TTL_MS - days * 86400000).toISOString() : null;
  const projectPaths = db.prepare('SELECT path FROM projects').all() as unknown as { path: string }[];
  const commitCounts = await Promise.all(projectPaths.map((p) => cachedCommitCountSince(p.path, commitCutoff)));
  const commits = commitCounts.reduce((a, b) => a + b, 0);

  return {
    sessions, toolDist, kindDist, modelDist, modelDistFixed, errors, errorsByProject, commits,
    dailyActivity, hourlyActivity, projects,
    rangedTokensByModel, dailySpend, hourlySpend,
  };
}
