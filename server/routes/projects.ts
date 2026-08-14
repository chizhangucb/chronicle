import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { db, upsertProject, tombstoneSessionsForProject, type ProjectRow } from '../db.ts';
import * as gitEngine from '../git.ts';
import { liveCandidatesForSessions, liveWatcherSessionIds } from '../live.ts';
import { cached, invalidateCache } from '../cache.ts';
import { backupDbBeforeDelete } from './_shared.ts';
import { overlapGate, windowedUsage, type WindowedUsageCell } from '../windowUsage.ts';

interface ProjectListRow extends ProjectRow {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
}

interface RawSessionRow {
  id: string;
  source: string;
  file_path: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  name: string | null;
  summary: string | null;
  context_tokens: number | null;
  usage: string | null;
  agent_active_ms: number | null;
  char_count: number | null;
}

// Mirrors server/activity.ts LIVE_WINDOW_MS — a session is "live" if it has an
// open SSE watcher OR its stored ended_at is within the trailing 5 minutes.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

export function mountProjects(app: Express): void {
  app.get('/projects', (_req: Request, res: Response) => {
    const projects = db.prepare(`
      SELECT p.*, COUNT(s.id) AS session_count, COALESCE(SUM(s.message_count),0) AS message_count,
             MAX(s.ended_at) AS last_active,
             GROUP_CONCAT(DISTINCT s.source) AS sources
      FROM projects p LEFT JOIN sessions s ON s.project_id = p.id AND COALESCE(s.minor, 0) = 0
      GROUP BY p.id ORDER BY last_active DESC`).all() as unknown as ProjectListRow[];
    // Cheap "any session live" flag per project (Task 17), no per-project
    // queries: one indexed scan for recently-ended sessions, plus a lookup for
    // any project owning a currently-open SSE watcher (usually 0-1 rows).
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
    const liveProjectIds = new Set(
      (db.prepare('SELECT DISTINCT project_id FROM sessions WHERE COALESCE(minor,0)=0 AND ended_at >= ?').all(cutoff) as unknown as { project_id: number }[])
        .map((r) => r.project_id),
    );
    const watcherIds = [...liveWatcherSessionIds()];
    if (watcherIds.length) {
      const placeholders = watcherIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT DISTINCT project_id FROM sessions WHERE id IN (${placeholders})`).all(...watcherIds) as unknown as { project_id: number }[];
      for (const r of rows) liveProjectIds.add(r.project_id);
    }
    res.json(projects.map((p) => ({ ...p, git: gitEngine.repoInfo(p.path), live: liveProjectIds.has(p.id) })));
  });

  app.get('/projects/:id', (req: Request, res: Response) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Not found' });
    // The DB-derived half (sessions + the four aggregation queries below) is
    // cached keyed by the full request URL — it only changes on a DB write.
    // git.repoInfo/commitCountSince are deliberately computed FRESH on every
    // request, outside the cache: the project-card git pill must show the
    // local checkout's live branch with no caching (see CLAUDE.md gotcha) —
    // a `git checkout` alone doesn't invalidate the result cache, so caching
    // git-derived fields here would make them go stale.
    const body = cached(req.originalUrl, () => {
      // Optional time range (?days=7/30/365) — filters sessions and all analytics.
      const days = Number(req.query.days) || null;
      const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
      // null (not '') for the windowed-usage primitive — see server/insights.ts's comment
      // on the same pattern for why (cutoffIso===null is windowedUsage's "All window" signal).
      const cutoffIso = days ? cutoff : null;
      // Minor (noise-gated) sessions are excluded from this main list — they
      // live in the global "minor sessions" bucket (GET /api/sessions/minor)
      // until promoted or ignored.
      // overlapGate (Task 2, the P0 fix — see server/windowUsage.ts): a session that
      // started before the window but ran INTO it (e.g. spans midnight into "Today")
      // still counts — replaces the old started_at-only gate that dropped it entirely.
      const rawSessions = db.prepare(`SELECT id, source, file_path, started_at, ended_at, message_count, first_prompt, name, summary, context_tokens, usage, agent_active_ms,
          (SELECT SUM(LENGTH(COALESCE(m.text, '')) + LENGTH(COALESCE(m.tool_input, '')))
           FROM messages m WHERE m.session_id = sessions.id) AS char_count
        FROM sessions WHERE project_id = ? AND ${overlapGate('sessions')} AND COALESCE(minor, 0) = 0 ORDER BY started_at DESC`).all(project.id, cutoff) as unknown as RawSessionRow[];
      const liveIds = liveCandidatesForSessions(rawSessions);
      // "Ongoing" = the source log was written to in the last 10 minutes — the
      // session is likely still in progress (auto-sync keeps it fresh; stats read
      // "so far" in the UI).
      const ONGOING_MS = 10 * 60 * 1000;
      const sessions = rawSessions.map(({ file_path, ...s }) => {
        let ongoing = false;
        try { ongoing = Date.now() - fs.statSync(file_path).mtime.getTime() < ONGOING_MS; } catch {}
        return { ...s, liveCandidate: liveIds.has(s.id), ongoing };
      });
      // CROSS JOIN pins sessions as the outer loop so messages come from the
      // covering idx_messages_agg index instead of a full table scan — same
      // perf-fix shape as server/insights.ts (see the index comment in db.ts).
      // overlapGate on session inclusion + `m.ts >= ?` restricts message-level
      // aggregates to messages that actually fall in-window (Task 2).
      const toolDist = db.prepare(`SELECT m.tool_name AS name, COUNT(*) AS count
        FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
        WHERE s.project_id = ? AND ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0 AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL AND m.ts >= ?
        GROUP BY m.tool_name ORDER BY count DESC LIMIT 24`).all(project.id, cutoff, cutoff);
      const kindDist = db.prepare(`SELECT m.kind AS kind, COUNT(*) AS count
        FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
        WHERE s.project_id = ? AND ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0 AND m.ts >= ? GROUP BY m.kind`).all(project.id, cutoff, cutoff);
      // LOCAL-time bucket keys (Task 2 / plan's timezone convention) — see
      // server/insights.ts's dailyActivity for the same fix.
      const activity = db.prepare(`SELECT strftime('%Y-%m-%d', m.ts, 'localtime') AS day, COUNT(*) AS count
        FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
        WHERE s.project_id = ? AND ${overlapGate('s')} AND COALESCE(s.minor, 0) = 0 AND m.ts IS NOT NULL AND m.ts >= ?
        GROUP BY day ORDER BY day`).all(project.id, cutoff, cutoff);
      // Precomputed at import (db.ts replaceSession, shared server/errors.ts
      // heuristic) — no per-request regex over tool_result heads. Session-level
      // (no messages join), so only the overlap gate applies.
      // KNOWN WINDOWING TRADEOFF (same as server/insights.ts's errorsByProject, see
      // that comment for the full rationale): error_count is a WHOLE-SESSION
      // precomputed total, not scaled to the in-window share the token magnitudes get
      // via windowedUsage — overlapGate makes a spanning session correctly visible for
      // "Today", but its error count is its FULL historical count. There's no
      // per-message error timestamp to cheaply re-slice by without re-running the
      // tool_result/tool_use pairing join per request (the exact cost this precomputed
      // column exists to avoid).
      const errors = ((db.prepare(`SELECT SUM(COALESCE(error_count, 0)) AS ec FROM sessions
        WHERE project_id = ? AND ${overlapGate('sessions')} AND COALESCE(minor, 0) = 0`)
        .get(project.id, cutoff) as unknown as { ec: number | null }).ec) ?? 0;
      // Windowed per-model billed cells (Task 2): the client (Task 3) prices these for the
      // project KPIs instead of summing raw session.usage, so they agree with the session
      // list above at every window, including a spanning session's partial in-window share.
      const windowedTokensByModel: WindowedUsageCell[] = windowedUsage(db, 'AND s.project_id = ?', [project.id], cutoffIso);
      return { sessions, analyticsBase: { toolDist, kindDist, activity, errors, windowedTokensByModel }, cutoff };
    });
    const commits = gitEngine.commitCountSince(project.path, body.cutoff || null);
    res.json({ project, sessions: body.sessions, git: gitEngine.repoInfo(project.path),
      analytics: { ...body.analyticsBase, commits } });
  });

  // ---- Project management (FR-PM-3/4/5) ----

  app.patch('/projects/:id', (req: Request, res: Response) => {
    if (req.body.name) {
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(req.body.name, (req.params.id as string));
      invalidateCache();
    }
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)));
  });

  // Manual association: move all sessions on a virtual/wrong path to a real path.
  // Auto-merges into an existing project at that path (FR-PM-3).
  app.post('/projects/:id/associate', (req: Request, res: Response) => {
    const { path: newPath } = req.body;
    if (!newPath || !fs.existsSync(newPath)) return res.status(400).json({ error: 'Path does not exist on disk' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Not found' });
    const target = upsertProject(newPath);
    if (target.id !== project.id) {
      db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(target.id, project.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
      invalidateCache();
    }
    res.json({ ok: true, projectId: target.id });
  });

  // Unlink a source: its sessions move to an independent project (FR-PM-5).
  app.post('/projects/:id/unlink', (req: Request, res: Response) => {
    const { source } = req.body;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project || !source) return res.status(400).json({ error: 'project/source required' });
    const virtualPath = `${project.path}#${source}`;
    const target = upsertProject(virtualPath);
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(`${project.name} (${source})`, target.id);
    db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ? AND source = ?')
      .run(target.id, project.id, source);
    invalidateCache();
    res.json({ ok: true, projectId: target.id });
  });

  app.delete('/projects/:id', (req: Request, res: Response) => {
    backupDbBeforeDelete();
    // Tombstone every session first (still readable while it exists) so a
    // paused-then-resumed auto-sync can't resurrect them after the project
    // itself is gone.
    tombstoneSessionsForProject((req.params.id as string));
    db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)').run((req.params.id as string));
    db.prepare('DELETE FROM sessions WHERE project_id = ?').run((req.params.id as string));
    db.prepare('DELETE FROM projects WHERE id = ?').run((req.params.id as string));
    invalidateCache();
    res.json({ ok: true });
  });
}
