import fs from 'node:fs';
import { db } from '../db.ts';
import * as gitEngine from '../git.ts';
import { attachLiveStream, isLiveCandidate, liveStatus } from '../live.ts';
import { analyzeCausality } from '../causality.ts';
import { PER_FILE_SOURCES, backupDbBeforeDelete } from './_shared.js';

export function mountSessions(app) {
  // Tiny resolver for chronicle://session/<id> deep links.
  app.get('/sessions/:id/resolve', (req, res) => {
    const s = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  // Rename a session (user-set display name; survives re-import — see db.replaceSession).
  app.patch('/sessions/:id', (req, res) => {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (req.body.name !== undefined) {
      const name = (req.body.name || '').trim() || null; // empty clears back to the default
      db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, req.params.id);
    }
    res.json(db.prepare('SELECT id, name, summary, first_prompt FROM sessions WHERE id = ?').get(req.params.id));
  });

  app.get('/sessions/:id/messages', (req, res) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(session.id);
    const commits = session.started_at && session.ended_at
      ? gitEngine.commitsBetween(project.path, session.started_at, session.ended_at) : [];
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id);
    res.json({ session, project, messages, commits, git: gitEngine.repoInfo(project.path),
      liveCandidate: isLiveCandidate(session.file_path, session, peers) });
  });

  app.delete('/sessions/:id/source-file', (req, res) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!PER_FILE_SOURCES.has(session.source)) {
      return res.status(400).json({ error: `${session.source} keeps sessions in shared storage — deleting the file would remove other sessions too` });
    }
    if (!fs.existsSync(session.file_path) || !fs.statSync(session.file_path).isFile()) {
      return res.status(400).json({ error: 'Source file no longer exists on disk' });
    }
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id);
    if (isLiveCandidate(session.file_path, session, peers)) {
      return res.status(400).json({ error: 'This session is live right now — wait for it to finish before deleting its log' });
    }
    try {
      fs.unlinkSync(session.file_path);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Delete a session's imported copy from Chronicle; ?source=1 also permanently
  // deletes the original log file (same per-file-source restriction as above).
  app.delete('/sessions/:id', (req, res) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    const peers = db.prepare('SELECT id, file_path, ended_at FROM sessions WHERE project_id = ?').all(session.project_id);
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
        catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
      }
    }
    backupDbBeforeDelete();
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    res.json({ ok: true, sourceDeleted });
  });

  // ---- Live streaming (FR-LS): SSE tail of the session's log file ----

  app.get('/sessions/:id/live', (req, res) => {
    if (!attachLiveStream(req.params.id, res)) {
      res.status(400).json({ error: 'Live streaming unavailable for this session (missing file or SQLite source)' });
    }
  });
  app.get('/live/status', (req, res) => res.json(liveStatus()));

  // ---- Context Causality (FR-CC) ----

  app.get('/sessions/:id/causality', (req, res) => {
    try { res.json(analyzeCausality(req.params.id)); }
    catch (err) { res.status(500).json({ error: String(err.message || err) }); }
  });
}
