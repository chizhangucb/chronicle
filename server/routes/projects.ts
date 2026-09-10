import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { db, upsertProject, tombstoneSessionsForProject } from '../db.ts';
import type { ProjectRow } from '../../shared/rows.ts';
import * as gitEngine from '../git.ts';
import { liveCandidatesForSessions, liveWatcherSessionIds, isLiveCandidate } from '../live.ts';
import { cached, invalidateCache } from '../cache.ts';
import { backupDbBeforeDelete } from './_shared.ts';
import { computeScopedAggregates } from '../insights.ts';
import { queryContext, rangeOf, whereOf, type Scope } from '../scope.ts';
import type { ProjectSessionSummary } from '../../shared/rows.ts';
import type { ProjectDetailResult, ProjectListItem } from '../../shared/results.ts';

interface ProjectListRow extends ProjectRow {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
}

// The session row this route projects, minus the two live flags it computes
// below: shared/rows.ts owns the shape (#307) and the project page imports it.
// (`file_path` is selected here to date the transcript, then stripped before
// the row goes out.)
type RawSessionRow = Omit<ProjectSessionSummary, 'liveCandidate' | 'ongoing'> & { file_path: string };

// Mirrors server/activity.ts LIVE_WINDOW_MS — a session is "live" if it has an
// open SSE watcher OR its stored ended_at is within the trailing 5 minutes.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

export function mountProjects(app: Express): void {
  app.get('/projects', (_req: Request, res: Response) => {
    // Scope 'all' over every range: the list itself is unranged, so only the
    // minor gate comes out of the query context here.
    const listQ = queryContext({ type: 'all' }, rangeOf(null));
    const projects = db.prepare(`
      SELECT p.*, COUNT(s.id) AS session_count, COALESCE(SUM(s.message_count),0) AS message_count,
             MAX(s.ended_at) AS last_active,
             GROUP_CONCAT(DISTINCT s.source) AS sources
      FROM projects p LEFT JOIN sessions s ON s.project_id = p.id ${listQ.where.sql}
      GROUP BY p.id ORDER BY last_active DESC`).all(...listQ.where.params) as unknown as ProjectListRow[];
    // Cheap "any session live" flag per project, no per-project
    // queries: one indexed scan for recently-ended sessions, plus a lookup for
    // any project owning a currently-open SSE watcher (usually 0-1 rows).
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
    const liveWhere = whereOf(listQ.where, { sql: 'AND s.ended_at >= ?', params: [cutoff] });
    const liveProjectIds = new Set(
      (db.prepare(`SELECT DISTINCT s.project_id FROM sessions s WHERE ${liveWhere.sql}`).all(...liveWhere.params) as unknown as { project_id: number }[])
        .map((r) => r.project_id),
    );
    const watcherIds = [...liveWatcherSessionIds()];
    if (watcherIds.length) {
      const placeholders = watcherIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT DISTINCT project_id FROM sessions WHERE id IN (${placeholders})`).all(...watcherIds) as unknown as { project_id: number }[];
      for (const r of rows) liveProjectIds.add(r.project_id);
    }
    // Source-log freshness: an active CLI session that nobody has
    // open in Chronicle has neither an open live watcher nor a recent
    // ended_at (that only updates on import), so the two checks above miss
    // it entirely. A running session keeps writing its source log though —
    // fall back to statting the file mtime of each project's MOST RECENT
    // session (SQLite's documented bare-column behavior: with exactly one
    // MAX() aggregate in the query, the non-aggregated columns are taken
    // from the row that produced the max — see sqlite.org/lang_select.html
    // #bare_columns_in_an_aggregate_query), so this is one cheap stat per
    // project, not per session.
    const latestWhere = whereOf(listQ.where);
    const latestFiles = db.prepare(`
      SELECT s.project_id, s.file_path, MAX(s.started_at) AS started_at
      FROM sessions s WHERE ${latestWhere.sql}
      GROUP BY s.project_id`).all(...latestWhere.params) as unknown as { project_id: number; file_path: string | null }[];
    for (const r of latestFiles) {
      if (!liveProjectIds.has(r.project_id) && r.file_path && isLiveCandidate(r.file_path)) {
        liveProjectIds.add(r.project_id);
      }
    }
    const list: ProjectListItem[] = projects.map((p) => ({ ...p, git: gitEngine.repoInfo(p.path), live: liveProjectIds.has(p.id) }));
    res.json(list);
  });

  app.get('/projects/:id', (req: Request, res: Response) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Not found' });
    // The DB-derived half (the session list plus the engine's scoped
    // aggregates) is cached keyed by the full request URL: it only changes on
    // a DB write.
    // git.repoInfo/commitCountSince are deliberately computed FRESH on every
    // request, outside the cache: the project-card git pill must show the
    // local checkout's live branch with no caching (see CLAUDE.md gotcha) —
    // a `git checkout` alone doesn't invalidate the result cache, so caching
    // git-derived fields here would make them go stale.
    const body = cached(req.originalUrl, () => {
      // Optional time range (?days=7/30/365) — filters sessions and all analytics.
      const days = Number(req.query.days) || null;
      const scope: Scope = { type: 'project', id: project.id };
      const range = rangeOf(days);
      // One query context for the session list: the project scope clause, the
      // minor gate (noise-gated sessions live in the global "minor sessions"
      // bucket, GET /api/sessions/minor, until promoted or ignored) and the
      // session range, see server/scope.ts. The analytics take the same scope
      // and range through the engine below.
      const q = queryContext(scope, range);
      const cutoff = q.range.cutoffIso ?? '';
      const sessionWhere = q.sessionRows;
      const rawSessions = db.prepare(`SELECT s.id, s.source, s.file_path, s.started_at, s.ended_at, s.message_count, s.first_prompt, s.name, s.summary, s.context_tokens, s.usage, s.agent_active_ms,
          (SELECT SUM(LENGTH(COALESCE(m.text, '')) + LENGTH(COALESCE(m.tool_input, '')))
           FROM messages m WHERE m.session_id = s.id) AS char_count
        FROM sessions s WHERE ${sessionWhere.sql} ORDER BY s.started_at DESC`).all(...sessionWhere.params) as unknown as RawSessionRow[];
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
      // The four aggregates and the ranged billed cells are the Insights
      // engine's, called with this project's scope (#305), not a second copy
      // of the same queries. Insights scoped to this project reports the same
      // numbers because it runs the same code.
      const { toolDist, kindDist, activity, errors, rangedTokensByModel } = computeScopedAggregates(scope, range);
      return { sessions, analyticsBase: { toolDist, kindDist, activity, errors, rangedTokensByModel }, cutoff };
    });
    const commits = gitEngine.commitCountSince(project.path, body.cutoff || null);
    const payload: ProjectDetailResult = { project, sessions: body.sessions, git: gitEngine.repoInfo(project.path),
      analytics: { ...body.analyticsBase, commits } };
    res.json(payload);
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
