import express from 'express';
import fs from 'node:fs';
import { db, upsertProject, ftsAvailable } from './db.js';
import { analyzeCausality } from './causality.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from './security.js';
import { attachLiveStream, isLiveCandidate, liveCandidatesForSessions, liveStatus } from './live.js';
import { startAutoSync } from './autosync.js';
import { PER_FILE_SOURCES, backupDbBeforeDelete } from './routes/_shared.js';
import { mountImportSync } from './routes/import-sync.js';
import { mountSettings } from './routes/settings.js';

export const api = express();
api.use(express.json());

mountImportSync(api);
mountSettings(api);

// Tiny resolver for chronicle://session/<id> deep links.
api.get('/sessions/:id/resolve', (req, res) => {
  const s = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// ---- Projects & sessions ----

api.get('/projects', (req, res) => {
  const projects = db.prepare(`
    SELECT p.*, COUNT(s.id) AS session_count, COALESCE(SUM(s.message_count),0) AS message_count,
           MAX(s.ended_at) AS last_active,
           GROUP_CONCAT(DISTINCT s.source) AS sources
    FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id ORDER BY last_active DESC`).all();
  res.json(projects.map((p) => ({ ...p, git: gitEngine.repoInfo(p.path) })));
});

// Heuristic error detection (mirrors the client-side Overview heuristic).
const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;

api.get('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Optional time range (?days=7/30/365) — filters sessions and all analytics.
  const days = Number(req.query.days) || null;
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const rawSessions = db.prepare(`SELECT id, source, file_path, started_at, ended_at, message_count, first_prompt, name, summary, context_tokens, usage, agent_active_ms,
      (SELECT SUM(LENGTH(COALESCE(m.text, '')) + LENGTH(COALESCE(m.tool_input, '')))
       FROM messages m WHERE m.session_id = sessions.id) AS char_count
    FROM sessions WHERE project_id = ? AND COALESCE(started_at, '9') >= ? ORDER BY started_at DESC`).all(project.id, cutoff);
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
  const toolDist = db.prepare(`SELECT m.tool_name AS name, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL
    GROUP BY m.tool_name ORDER BY count DESC LIMIT 24`).all(project.id, cutoff);
  const kindDist = db.prepare(`SELECT m.kind AS kind, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? GROUP BY m.kind`).all(project.id, cutoff);
  const activity = db.prepare(`SELECT substr(m.ts, 1, 10) AS day, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND m.ts IS NOT NULL
    GROUP BY day ORDER BY day`).all(project.id, cutoff);
  const errors = db.prepare(`SELECT substr(m.text, 1, 200) AS head FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND COALESCE(s.started_at, '9') >= ? AND m.kind = 'tool_result' AND m.text IS NOT NULL`)
    .all(project.id, cutoff)
    .reduce((n, r) => n + (ERROR_RE.test(r.head) ? 1 : 0), 0);
  res.json({ project, sessions, git: gitEngine.repoInfo(project.path), analytics: { toolDist, kindDist, activity, errors } });
});

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

// ---- Project management (FR-PM-3/4/5) ----

api.patch('/projects/:id', (req, res) => {
  if (req.body.name) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(req.body.name, req.params.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

// Manual association: move all sessions on a virtual/wrong path to a real path.
// Auto-merges into an existing project at that path (FR-PM-3).
api.post('/projects/:id/associate', (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || !fs.existsSync(newPath)) return res.status(400).json({ error: 'Path does not exist on disk' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const target = upsertProject(newPath);
  if (target.id !== project.id) {
    db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(target.id, project.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  }
  res.json({ ok: true, projectId: target.id });
});

// Unlink a source: its sessions move to an independent project (FR-PM-5).
api.post('/projects/:id/unlink', (req, res) => {
  const { source } = req.body;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !source) return res.status(400).json({ error: 'project/source required' });
  const virtualPath = `${project.path}#${source}`;
  const target = upsertProject(virtualPath);
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(`${project.name} (${source})`, target.id);
  db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ? AND source = ?')
    .run(target.id, project.id, source);
  res.json({ ok: true, projectId: target.id });
});

api.delete('/projects/:id', (req, res) => {
  backupDbBeforeDelete();
  db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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
