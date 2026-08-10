import express from 'express';
import { db, ftsAvailable } from './db.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from './security.js';
import { startAutoSync } from './autosync.js';
import { mountImportSync } from './routes/import-sync.js';
import { mountSettings } from './routes/settings.js';
import { mountProjects } from './routes/projects.js';
import { mountSessions } from './routes/sessions.js';

export const api = express();
api.use(express.json());

mountImportSync(api);
mountSettings(api);
mountProjects(api);
mountSessions(api);

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
