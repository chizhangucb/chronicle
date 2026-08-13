import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { db, tombstoneSession, removeTombstone, type SessionRow, type ProjectRow, type MessageRow } from '../db.ts';
import * as gitEngine from '../git.ts';
import { attachLiveStream, isLiveCandidate, liveStatus } from '../live.ts';
import { analyzeCausality } from '../causality.ts';
import { invalidateCache } from '../cache.ts';
import { PER_FILE_SOURCES, backupDbBeforeDelete } from './_shared.ts';

type PeerRow = Pick<SessionRow, 'id' | 'file_path' | 'ended_at'>;

interface MinorSessionRow {
  id: string;
  project_id: number;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  message_count: number;
  agent_active_ms: number | null;
  started_at: string | null;
  project_name: string;
}

export function mountSessions(app: Express): void {
  // ---- Noise gate: the global "minor sessions" bucket (Phase 5 PR 5a) ----

  app.get('/sessions/minor', (_req: Request, res: Response) => {
    const rows = db.prepare(`SELECT s.id, s.project_id, s.source, s.name, s.summary, s.first_prompt,
        s.message_count, s.agent_active_ms, s.started_at, p.name AS project_name
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.minor = 1
      ORDER BY COALESCE(s.started_at, '') DESC LIMIT 500`).all() as unknown as MinorSessionRow[];
    res.json(rows);
  });

  // Promote a minor session back into the main lists (sticky across re-import — see db.ts replaceSession).
  app.post('/sessions/:id/promote', (req: Request, res: Response) => {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get((req.params.id as string));
    if (!session) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE sessions SET minor = 0 WHERE id = ?').run((req.params.id as string));
    invalidateCache();
    res.json({ ok: true });
  });

  // Undo a session delete: forget the tombstone. The source log was never
  // touched, so the caller re-triggers a sync afterward to bring it back.
  app.post('/sessions/undo-delete', (req: Request, res: Response) => {
    const { source, id } = req.body || {};
    if (!source || !id) return res.status(400).json({ error: 'source and id required' });
    removeTombstone(source, id);
    res.json({ ok: true });
  });

  // Tiny resolver for chronicle://session/<id> deep links.
  app.get('/sessions/:id/resolve', (req: Request, res: Response) => {
    const s = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get((req.params.id as string));
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  // Rename a session (user-set display name; survives re-import — see db.replaceSession).
  app.patch('/sessions/:id', (req: Request, res: Response) => {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get((req.params.id as string));
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (req.body.name !== undefined) {
      const name = (req.body.name || '').trim() || null; // empty clears back to the default
      db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, (req.params.id as string));
      invalidateCache();
    }
    res.json(db.prepare('SELECT id, name, summary, first_prompt FROM sessions WHERE id = ?').get((req.params.id as string)));
  });

  app.get('/sessions/:id/messages', (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params.id as string)) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id) as unknown as ProjectRow;
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(session.id) as unknown as MessageRow[];
    const commits = session.started_at && session.ended_at
      ? gitEngine.commitsBetween(project.path, session.started_at, session.ended_at) : [];
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id) as unknown as PeerRow[];
    res.json({ session, project, messages, commits, git: gitEngine.repoInfo(project.path),
      liveCandidate: isLiveCandidate(session.file_path, session, peers) });
  });

  app.delete('/sessions/:id/source-file', (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params.id as string)) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!PER_FILE_SOURCES.has(session.source)) {
      return res.status(400).json({ error: `${session.source} keeps sessions in shared storage — deleting the file would remove other sessions too` });
    }
    if (!fs.existsSync(session.file_path) || !fs.statSync(session.file_path).isFile()) {
      return res.status(400).json({ error: 'Source file no longer exists on disk' });
    }
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id) as unknown as PeerRow[];
    if (isLiveCandidate(session.file_path, session, peers)) {
      return res.status(400).json({ error: 'This session is live right now — wait for it to finish before deleting its log' });
    }
    try {
      fs.unlinkSync(session.file_path);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String((err as Error).message || err) });
    }
  });

  // Delete a session's imported copy from Chronicle; ?source=1 also permanently
  // deletes the original log file (same per-file-source restriction as above).
  app.delete('/sessions/:id', (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params.id as string)) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Not found' });
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id) as unknown as PeerRow[];
    if (isLiveCandidate(session.file_path, session, peers)) {
      return res.status(400).json({ error: 'This session is live right now — wait for it to finish before deleting' });
    }
    let sourceDeleted = false;
    if (req.query.source === '1') {
      if (!PER_FILE_SOURCES.has(session.source)) {
        return res.status(400).json({ error: `${session.source} keeps sessions in shared storage — deleting the file would remove other sessions too` });
      }
      if (fs.existsSync(session.file_path) && fs.statSync(session.file_path).isFile()) {
        try { fs.unlinkSync(session.file_path); sourceDeleted = true; }
        catch (err) { return res.status(500).json({ error: String((err as Error).message || err) }); }
      }
    }
    backupDbBeforeDelete();
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    // A deliberate delete tombstones the (source, id) pair so a subsequent
    // import/sync/auto-sync of the same source log never resurrects it —
    // "Undo" (POST /sessions/undo-delete) just forgets the tombstone.
    tombstoneSession(session.source, session.id);
    invalidateCache();
    res.json({ ok: true, sourceDeleted, source: session.source, projectId: session.project_id });
  });

  // ---- Live streaming (FR-LS): SSE tail of the session's log file ----

  app.get('/sessions/:id/live', (req: Request, res: Response) => {
    if (!attachLiveStream((req.params.id as string), res)) {
      res.status(400).json({ error: 'Live streaming unavailable for this session (missing file or SQLite source)' });
    }
  });
  app.get('/live/status', (_req: Request, res: Response) => res.json(liveStatus()));

  // ---- Context Causality (FR-CC) ----

  app.get('/sessions/:id/causality', (req: Request, res: Response) => {
    try { res.json(analyzeCausality((req.params.id as string))); }
    catch (err) { res.status(500).json({ error: String((err as Error).message || err) }); }
  });
}
