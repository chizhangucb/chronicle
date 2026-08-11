// Global cross-project aggregation for the Insights hub (Task 5d-4). Mirrors
// the per-project analytics shapes in server/routes/projects.ts, but scoped
// across ALL projects instead of one — same query patterns (COALESCE(minor,0)
// = 0 gate, COALESCE(started_at,'9') >= cutoff), same ERROR_RE heuristic
// (keep in sync with server/routes/projects.ts + src/SessionView.tsx's
// isErrorResult per the existing "two copies" gotcha).
//
// `dailyActivity`/`hourlyActivity` are DELIBERATELY exempt from the `days=`
// filter — Working Rhythm (src/insights/WorkingRhythm.tsx) always shows a
// fixed trailing 182-day calendar heatmap and a fixed trailing 30-day
// hour-of-day heatmap, independent of the page's range control.
import { db } from './db.ts';
import { commitCountSince } from './git.ts';

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
  errors: number;
  errorsByProject: { project_id: number; head_count: number; error_count: number }[];
  commits: number;
  dailyActivity: { day: string; count: number }[];
  hourlyActivity: { dow: number; hour: number; count: number }[];
  projects: { id: number; name: string }[];
}

// Mirrors ERROR_RE in server/routes/projects.ts and isErrorResult in
// src/SessionView.tsx — change all three together or the Errors counts diverge.
const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;
const CALENDAR_WINDOW_DAYS = 182;
const HOURLY_WINDOW_DAYS = 30;

export function computeInsights(days: number | null): InsightsResult {
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const calendarCutoff = new Date(Date.now() - CALENDAR_WINDOW_DAYS * 86400000).toISOString();
  const hourlyCutoff = new Date(Date.now() - HOURLY_WINDOW_DAYS * 86400000).toISOString();

  const sessions = db.prepare(`
    SELECT s.id, s.project_id, p.name AS project_name, s.source, s.name, s.summary, s.first_prompt,
           s.started_at, s.ended_at, s.message_count, s.agent_active_ms, s.engaged_ms, s.context_tokens, s.usage
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0
    ORDER BY s.started_at DESC
  `).all(cutoff) as unknown as InsightsSessionRow[];

  const toolDist = db.prepare(`
    SELECT m.tool_name AS name, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0
      AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL
    GROUP BY m.tool_name ORDER BY count DESC LIMIT 24
  `).all(cutoff) as unknown as { name: string; count: number }[];

  const kindDist = db.prepare(`
    SELECT m.kind AS kind, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0
    GROUP BY m.kind
  `).all(cutoff) as unknown as { kind: string; count: number }[];

  const modelDist = db.prepare(`
    SELECT m.model AS model, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0
      AND m.kind = 'assistant' AND m.model IS NOT NULL
    GROUP BY m.model ORDER BY count DESC
  `).all(cutoff) as unknown as { model: string; count: number }[];

  const resultHeads = db.prepare(`
    SELECT s.project_id AS project_id, substr(m.text, 1, 200) AS head FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0
      AND m.kind = 'tool_result' AND m.text IS NOT NULL
  `).all(cutoff) as unknown as { project_id: number; head: string }[];
  const errors = resultHeads.reduce((n, r) => n + (ERROR_RE.test(r.head) ? 1 : 0), 0);
  const errorsByProjectMap = new Map<number, { head_count: number; error_count: number }>();
  for (const r of resultHeads) {
    const cur = errorsByProjectMap.get(r.project_id) ?? { head_count: 0, error_count: 0 };
    cur.head_count++;
    if (ERROR_RE.test(r.head)) cur.error_count++;
    errorsByProjectMap.set(r.project_id, cur);
  }
  const errorsByProject = [...errorsByProjectMap.entries()].map(([project_id, v]) => ({ project_id, ...v }));

  // Fixed trailing windows — NOT filtered by `days=` (see file header).
  const dailyActivity = db.prepare(`
    SELECT substr(m.ts, 1, 10) AS day, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.ts >= ? AND COALESCE(s.minor, 0) = 0
    GROUP BY day ORDER BY day
  `).all(calendarCutoff) as unknown as { day: string; count: number }[];

  const hourlyActivity = db.prepare(`
    SELECT CAST(strftime('%w', m.ts) AS INTEGER) AS dow, CAST(strftime('%H', m.ts) AS INTEGER) AS hour, COUNT(*) AS count
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.ts >= ? AND COALESCE(s.minor, 0) = 0
    GROUP BY dow, hour
  `).all(hourlyCutoff) as unknown as { dow: number; hour: number; count: number }[];

  const projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all() as unknown as { id: number; name: string }[];

  let commits = 0;
  for (const p of db.prepare('SELECT path FROM projects').all() as unknown as { path: string }[]) {
    commits += commitCountSince(p.path, cutoff || null);
  }

  return { sessions, toolDist, kindDist, modelDist, errors, errorsByProject, commits, dailyActivity, hourlyActivity, projects };
}
