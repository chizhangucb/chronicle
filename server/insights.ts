// Global cross-project aggregation for the Insights hub (Task 5d-4). Mirrors
// the per-project analytics shapes in server/routes/projects.ts, but scoped
// across ALL projects instead of one — same query patterns (COALESCE(minor,0)
// = 0 gate, overlapGate session-inclusion — see server/windowUsage.ts). Error
// counts read the per-session result_count/error_count columns precomputed at
// import with the shared server/errors.ts heuristic (client twin:
// src/SessionView.tsx's isErrorResult).
//
// `dailyActivity`/`hourlyActivity` are DELIBERATELY exempt from the `days=`
// filter — Working Rhythm (src/insights/WorkingRhythm.tsx) always shows a
// fixed trailing 182-day calendar heatmap and a fixed trailing 30-day
// hour-of-day heatmap, independent of the page's range control.
import { db } from './db.ts';
import { commitCountSinceAsync } from './git.ts';
import { readLaneCSpend, type LaneCSpend } from './laneC.ts';
import { overlapGate, windowedUsage, bucketedUsage, type WindowedUsageCell, type BucketedUsageCell } from './windowUsage.ts';

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
  toolDist: { name: string; count: number }[];
  kindDist: { kind: string; count: number }[];
  modelDist: { model: string; count: number }[];
  // Fixed 30-day-trailing model distribution — same window as
  // hourlyActivity (see HOURLY_WINDOW_DAYS below), NOT the `days=` cutoff.
  // Working Rhythm's "Favorite model" stat reads this instead of `modelDist`
  // so it stays in step with its card-mates (Active days/streaks/Peak hour),
  // which all use the same fixed window and must not move when the page's
  // range control changes.
  modelDistFixed: { model: string; count: number }[];
  errors: number;
  errorsByProject: { project_id: number; head_count: number; error_count: number }[];
  commits: number;
  dailyActivity: { day: string; count: number }[];
  hourlyActivity: { dow: number; hour: number; count: number }[];
  projects: { id: number; name: string }[];
  // Lane C: authoritative proxy-lane billed spend (LiteLLM), model+time only,
  // NOT session-linked. Honors the same `days=` cutoff as the rest of the page.
  laneC: LaneCSpend;
  // Windowed billed cells (Task 2, feedback-round P0 fix): per-session,
  // per-model, in-window-scaled — the client (Task 3) prices these for the
  // KPI strip / spend-by-model / sources / top-sessions instead of summing
  // raw `sessions.usage`, so a session that started before the window but ran
  // INTO it (the root defect — see server/windowUsage.ts) contributes its
  // in-window share instead of vanishing (old gate) or over-counting (naive
  // overlap-only gate).
  windowedTokensByModel: WindowedUsageCell[];
  // Same cells, additionally bucketed by LOCAL calendar day — feeds the
  // Today/7d/30d spend-over-time chart without a UTC/local double-shift.
  dailySpend: BucketedUsageCell[];
  // Same, bucketed by LOCAL hour-of-day — only meaningful (and only
  // computed) for a short window, so it's null unless days<=2 (Today or just
  // past it); the client falls back to dailySpend otherwise.
  hourlySpend: BucketedUsageCell[] | null;
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

export async function computeInsights(days: number | null): Promise<InsightsResult> {
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  // null (not '') for the windowed-usage primitives — cutoffIso===null is their explicit
  // "All window, no scaling" signal (server/windowUsage.ts), distinct from the SQL '' sentinel
  // the raw queries below use for "no days= filter" (COALESCE(...) >= '' is always true).
  const cutoffIso = days ? cutoff : null;
  const nowMinute = Math.floor(Date.now() / 60000) * 60000;
  const calendarCutoff = new Date(nowMinute - CALENDAR_WINDOW_DAYS * 86400000).toISOString();
  const hourlyCutoff = new Date(nowMinute - HOURLY_WINDOW_DAYS * 86400000).toISOString();

  // overlapGate replaces the old `COALESCE(s.started_at,'9') >= ?` gate: a session whose
  // activity ran INTO the window now counts, not just one that STARTED in it (the P0 fix —
  // see server/windowUsage.ts). `m.ts >= ?` on the message-level aggregates below
  // additionally restricts to messages that actually fall in-window (not every message of a
  // session that merely overlaps it).
  const sessions = db.prepare(`
    SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
           s.started_at, s.ended_at, s.message_count, s.agent_active_ms, s.engaged_ms, s.context_tokens, s.usage
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0
    ORDER BY s.started_at DESC
  `).all(cutoff) as unknown as InsightsSessionRow[];

  // Every message-level aggregate below is written as `sessions CROSS JOIN
  // messages` ON PURPOSE: CROSS JOIN pins sessions (a few hundred slim rows)
  // as the outer loop, so messages are reached through the COVERING
  // idx_messages_agg index (see db.ts) instead of a full scan of the fat
  // messages table. That scan was the 0.1-3.6s-per-query (multi-second cold)
  // cost behind every Insights range click.
  const toolDist = db.prepare(`
    SELECT m.tool_name AS name, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0
      AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL AND m.ts >= ?
    GROUP BY m.tool_name ORDER BY count DESC LIMIT 24
  `).all(cutoff, cutoff) as unknown as { name: string; count: number }[];

  const kindDist = db.prepare(`
    SELECT m.kind AS kind, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0 AND m.ts >= ?
    GROUP BY m.kind
  `).all(cutoff, cutoff) as unknown as { kind: string; count: number }[];

  const modelDist = db.prepare(`
    SELECT m.model AS model, COUNT(*) AS count
    FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
    WHERE ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0
      AND m.kind = 'assistant' AND m.model IS NOT NULL AND m.ts >= ?
    GROUP BY m.model ORDER BY count DESC
  `).all(cutoff, cutoff) as unknown as { model: string; count: number }[];

  // Error stats come from the per-session result_count/error_count columns
  // precomputed at import (db.ts replaceSession + one-time backfill). The old
  // shape pulled EVERY tool_result head (35k+ rows on the maintainer's real
  // DB) into JS and regexed each one on every request — 0.8-17s per click.
  // Session-level (no messages join), so only the overlap gate applies here —
  // there's no per-message ts to additionally restrict by.
  const errorsByProject = db.prepare(`
    SELECT s.project_id AS project_id,
           SUM(COALESCE(s.result_count, 0)) AS head_count,
           SUM(COALESCE(s.error_count, 0)) AS error_count
    FROM sessions s
    WHERE ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0
    GROUP BY s.project_id
  `).all(cutoff) as unknown as { project_id: number; head_count: number; error_count: number }[];
  const errors = errorsByProject.reduce((n, r) => n + r.error_count, 0);

  // Windowed billed cells (Task 2) — see the InsightsResult field comments.
  // scopeWhere mirrors the same `COALESCE(s.minor,0)=0` gate every aggregate
  // above uses; windowedUsage/bucketedUsage apply overlapGate internally.
  const windowedTokensByModel = windowedUsage(db, 'AND COALESCE(s.minor,0)=0', [], cutoffIso);
  const dailySpend = bucketedUsage(db, 'AND COALESCE(s.minor,0)=0', [], cutoffIso, 'day');
  const hourlySpend = days != null && days <= 2
    ? bucketedUsage(db, 'AND COALESCE(s.minor,0)=0', [], cutoffIso, 'hour')
    : null;

  // Fixed trailing windows — NOT filtered by `days=` (see file header).
  // Cached briefly (see fixedCache above) since they're identical across
  // range clicks; a fresh import becomes visible once the short TTL expires.
  const fixedKey = `${calendarCutoff}::${hourlyCutoff}`;
  let fixed = fixedCache && fixedCache.key === fixedKey && fixedCache.expiresAt > Date.now() ? fixedCache.value : null;
  if (!fixed) {
    // LOCAL-time bucket keys (Task 2 / plan's timezone convention): a
    // 'localtime' modifier on strftime, not the old UTC substr(m.ts,1,10) —
    // so "today" on the calendar heatmap actually means the viewer's today.
    const dailyActivity = db.prepare(`
      SELECT strftime('%Y-%m-%d', m.ts, 'localtime') AS day, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE m.ts >= ? AND COALESCE(s.minor, 0) = 0
      GROUP BY day ORDER BY day
    `).all(calendarCutoff) as unknown as { day: string; count: number }[];

    const hourlyActivity = db.prepare(`
      SELECT CAST(strftime('%w', m.ts, 'localtime') AS INTEGER) AS dow, CAST(strftime('%H', m.ts, 'localtime') AS INTEGER) AS hour, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE m.ts >= ? AND COALESCE(s.minor, 0) = 0
      GROUP BY dow, hour
    `).all(hourlyCutoff) as unknown as { dow: number; hour: number; count: number }[];

    const modelDistFixed = db.prepare(`
      SELECT m.model AS model, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE m.ts >= ? AND COALESCE(s.minor, 0) = 0
        AND m.kind = 'assistant' AND m.model IS NOT NULL
      GROUP BY m.model ORDER BY count DESC
    `).all(hourlyCutoff) as unknown as { model: string; count: number }[];
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
  const commitCutoff = days ? new Date(Math.floor(Date.now() / COMMIT_CACHE_TTL_MS) * COMMIT_CACHE_TTL_MS - days * 86400000).toISOString() : null;
  const projectPaths = db.prepare('SELECT path FROM projects').all() as unknown as { path: string }[];
  const commitCounts = await Promise.all(projectPaths.map((p) => cachedCommitCountSince(p.path, commitCutoff)));
  const commits = commitCounts.reduce((a, b) => a + b, 0);

  return {
    sessions, toolDist, kindDist, modelDist, modelDistFixed, errors, errorsByProject, commits,
    dailyActivity, hourlyActivity, projects, laneC: readLaneCSpend(cutoff || null),
    windowedTokensByModel, dailySpend, hourlySpend,
  };
}
