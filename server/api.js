import express from 'express';
import fs from 'node:fs';
import { db, ftsAvailable } from './db.js';
import { analyzeCausality } from './causality.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from './security.js';
import { attachLiveStream, isLiveCandidate, liveStatus } from './live.js';
import { startAutoSync } from './autosync.js';
import { PER_FILE_SOURCES, backupDbBeforeDelete } from './routes/_shared.js';
import { mountImportSync } from './routes/import-sync.js';
import { mountSettings } from './routes/settings.js';
import { mountProjects } from './routes/projects.js';

export const api = express();
api.use(express.json());

mountImportSync(api);
mountSettings(api);
mountProjects(api);

// Tiny resolver for chronicle://session/<id> deep links.
api.get('/sessions/:id/resolve', (req, res) => {
  const s = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// ---- Projects & sessions ----

// Rename a session (user-set display name; survives re-import — see db.replaceSession).
api.patch('/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) {
    const name = (req.body.name || '').trim() || null; // empty clears back to the default
    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, req.params.id);
  }
  res.json(db.prepare('SELECT id, name, summary, first_prompt FROM sessions WHERE id = ?').get(req.params.id));
});

// ---- Global search (home command palette) ----
// Empty query → recent sessions ("Recent Access"). Non-empty → LIKE scan over
// message text/tool input, grouped per session with a highlighted snippet.
const SCOPE_KINDS = {
  code: ['tool_use', 'tool_result'],
  chat: ['user', 'assistant', 'thinking'],
};

function snippetAround(text, q, radius = 60) {
  if (!text) return '';
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  return (start > 0 ? '…' : '') + text.slice(start, i + q.length + radius) + (i + q.length + radius < text.length ? '…' : '');
}

api.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const scope = req.query.scope || 'all';
  const days = Number(req.query.days) || null;
  const projectId = req.query.project ? Number(req.query.project) : null;
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const kinds = SCOPE_KINDS[scope] || null;

  if (!q) {
    const where = ['1=1'];
    const params = [];
    if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
    const rows = db.prepare(`SELECT s.id, s.project_id, s.source, s.name, s.summary, s.first_prompt,
        s.started_at, s.ended_at, s.message_count, p.name AS project_name
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT 12`).all(...params);
    return res.json({ recent: true, results: rows.map((r) => ({ ...r, matchCount: 0, snippet: '', ts: r.ended_at || r.started_at })) });
  }

  // FTS5 MATCH (phrase query, prefix on the last term) with LIKE fallback when
  // the FTS table is unavailable or the query trips FTS syntax.
  const where = [];
  const params = [];
  if (kinds) { where.push(`m.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
  if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
  if (cutoff) { where.push("COALESCE(s.started_at, '9') >= ?"); params.push(cutoff); }
  const tail = where.length ? ' AND ' + where.join(' AND ') : '';
  const select = `SELECT m.session_id, m.seq, m.kind, m.text, m.tool_name, m.tool_input, m.ts,
      s.project_id, s.source, s.name, s.summary, s.first_prompt, p.name AS project_name
    FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id`;
  let rows = null;
  if (ftsAvailable) {
    try {
      const ftsQuery = `"${q.replace(/"/g, '""')}"*`;
      rows = db.prepare(`${select}
        JOIN messages_fts f ON f.rowid = m.id
        WHERE f MATCH ?${tail}
        ORDER BY m.ts DESC LIMIT 400`).all(ftsQuery, ...params);
    } catch { rows = null; }
  }
  if (rows === null) {
    const like = `%${q}%`;
    rows = db.prepare(`${select}
      WHERE (m.text LIKE ? OR m.tool_input LIKE ?)${tail}
      ORDER BY m.ts DESC LIMIT 400`).all(like, like, ...params);
  }

  const bySession = new Map();
  for (const r of rows) {
    let e = bySession.get(r.session_id);
    if (!e) {
      e = { id: r.session_id, project_id: r.project_id, source: r.source, name: r.name,
        summary: r.summary, first_prompt: r.first_prompt, project_name: r.project_name,
        matchCount: 0, snippet: '', seq: r.seq, ts: r.ts };
      bySession.set(r.session_id, e);
    }
    e.matchCount++;
    if (!e.snippet) {
      const hay = r.text && r.text.toLowerCase().includes(q.toLowerCase()) ? r.text : (r.tool_input || r.text || '');
      e.snippet = snippetAround(hay, q);
      e.seq = r.seq;
      e.ts = r.ts;
    }
  }
  res.json({ recent: false, results: [...bySession.values()].slice(0, 40) });
});

api.get('/sessions/:id/messages', (req, res) => {
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

api.delete('/sessions/:id/source-file', (req, res) => {
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
api.delete('/sessions/:id', (req, res) => {
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

api.get('/sessions/:id/live', (req, res) => {
  if (!attachLiveStream(req.params.id, res)) {
    res.status(400).json({ error: 'Live streaming unavailable for this session (missing file or SQLite source)' });
  }
});
api.get('/live/status', (req, res) => res.json(liveStatus()));

// ---- Context Causality (FR-CC) ----

api.get('/sessions/:id/causality', (req, res) => {
  try { res.json(analyzeCausality(req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// ---- Security: scan, rules, redacted export ----

api.get('/sessions/:id/security-check', (req, res) => {
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(req.params.id);
  if (!messages.length) return res.status(404).json({ error: 'Session not found or empty' });
  res.json(scanSession(messages));
});

// One-way redacted export (FR-SEC-7/8): original DB rows are never modified.
api.get('/sessions/:id/export-redacted', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(session.id);
  const scan = scanSession(messages);
  const redactedBySeq = new Map(scan.messages.map((m) => [m.seq, m]));
  const label = { user: 'User', assistant: 'Assistant', thinking: 'Thinking', tool_use: 'Tool call', tool_result: 'Tool result' };
  const lines = [`# ${project.name} — session export (redacted)`, '',
    `> ${session.source} · ${session.started_at ?? ''} · ${messages.length} messages · ${scan.findingCount} redactions`, ''];
  for (const m of messages) {
    const r = redactedBySeq.get(m.seq);
    const text = r ? r.redactedText : m.text;
    const input = r ? r.redactedInput : m.tool_input;
    lines.push(`### ${label[m.kind] || m.kind}${m.tool_name ? ` — ${m.tool_name}` : ''}`, '');
    if (input) lines.push('```json', input, '```', '');
    if (text) lines.push(text, '');
  }
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${project.name}-redacted.md"`);
  res.send(lines.join('\n'));
});

api.get('/security/rules', (req, res) => res.json(listRules()));
api.post('/security/rules', (req, res) => {
  const { name, pattern, replacement, kind } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern required' });
  addRule({ name, pattern, replacement, kind });
  res.json(listRules());
});
api.delete('/security/rules/:id', (req, res) => { deleteRule(req.params.id); res.json(listRules()); });
api.patch('/security/rules/:id', (req, res) => { toggleRule(req.params.id, !!req.body.enabled); res.json(listRules()); });

// ---- Git snapshot engine ----

function projectRepo(req, res) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.query.project);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  if (!gitEngine.isGitRepo(project.path)) { res.json({ noRepo: true }); return null; }
  return project;
}

api.get('/git/at', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  res.json({ commit: gitEngine.commitAt(project.path, req.query.ts) });
});

api.get('/git/tree', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  res.json({
    files: gitEngine.treeAt(project.path, req.query.commit),
    changed: gitEngine.changedFiles(project.path, req.query.commit),
  });
});

api.get('/git/file', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  try {
    res.json(gitEngine.fileAt(project.path, req.query.commit, req.query.path));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Auto-sync starts with the server in every run mode (dev / standalone /
// Electron); watchers + timer live on globalThis so SSR reloads don't orphan
// them. No-op when the user disabled auto-sync in settings.
startAutoSync();
