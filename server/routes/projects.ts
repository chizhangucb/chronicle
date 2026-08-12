import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { db, upsertProject, tombstoneSessionsForProject, type ProjectRow } from '../db.ts';
import * as gitEngine from '../git.ts';
import { liveCandidatesForSessions } from '../live.ts';
import { backupDbBeforeDelete } from './_shared.ts';

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

export function mountProjects(app: Express): void {
  app.get('/projects', (_req: Request, res: Response) => {
    const projects = db.prepare(`
      SELECT p.*, COUNT(s.id) AS session_count, COALESCE(SUM(s.message_count),0) AS message_count,
             MAX(s.ended_at) AS last_active,
             GROUP_CONCAT(DISTINCT s.source) AS sources
      FROM projects p LEFT JOIN sessions s ON s.project_id = p.id AND COALESCE(s.minor, 0) = 0
      GROUP BY p.id ORDER BY last_active DESC`).all() as unknown as ProjectListRow[];
    res.json(projects.map((p) => ({ ...p, git: gitEngine.repoInfo(p.path) })));
  });

  app.get('/projects/:id', (req: Request, res: Response) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Not found' });
    // Optional time range (?days=7/30/365) — filters sessions and all analytics.
    const days = Number(req.query.days) || null;
    const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
    // Minor (noise-gated) sessions are excluded from this main list — they
    // live in the global "minor sessions" bucket (GET /api/sessions/minor)
    // until promoted or ignored.
    const rawSessions = db.prepare(`SELECT id, source, file_path, started_at, ended_at, message_count, first_prompt, name, summary, context_tokens, usage, agent_active_ms,
        (SELECT SUM(LENGTH(COALESCE(m.text, '')) + LENGTH(COALESCE(m.tool_input, '')))
         FROM messages m WHERE m.session_id = sessions.id) AS char_count
      FROM sessions WHERE project_id = ? AND COALESCE(started_at, '9') >= ? AND COALESCE(minor, 0) = 0 ORDER BY started_at DESC`).all(project.id, cutoff) as unknown as RawSessionRow[];
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
    const toolDist = db.prepare(`SELECT m.tool_name AS name, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0 AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL
      GROUP BY m.tool_name ORDER BY count DESC LIMIT 24`).all(project.id, cutoff);
    const kindDist = db.prepare(`SELECT m.kind AS kind, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0 GROUP BY m.kind`).all(project.id, cutoff);
    const activity = db.prepare(`SELECT substr(m.ts, 1, 10) AS day, COUNT(*) AS count
      FROM sessions s CROSS JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND COALESCE(s.minor, 0) = 0 AND m.ts IS NOT NULL
      GROUP BY day ORDER BY day`).all(project.id, cutoff);
    // Precomputed at import (db.ts replaceSession, shared server/errors.ts
    // heuristic) — no per-request regex over tool_result heads.
    const errors = ((db.prepare(`SELECT SUM(COALESCE(error_count, 0)) AS ec FROM sessions
      WHERE project_id = ? AND COALESCE(started_at, '9') >= ? AND COALESCE(minor, 0) = 0`)
      .get(project.id, cutoff) as unknown as { ec: number | null }).ec) ?? 0;
    const commits = gitEngine.commitCountSince(project.path, cutoff || null);
    res.json({ project, sessions, git: gitEngine.repoInfo(project.path), analytics: { toolDist, kindDist, activity, errors, commits } });
  });

  // ---- Project management (FR-PM-3/4/5) ----

  app.patch('/projects/:id', (req: Request, res: Response) => {
    if (req.body.name) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(req.body.name, (req.params.id as string));
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
    res.json({ ok: true });
  });
}
