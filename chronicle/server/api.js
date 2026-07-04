import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, upsertProject, replaceSession } from './db.js';
import { scanClaudeProjects, parseClaudeSession } from './parsers/claudeCode.js';
import { scanCodexProjects, parseCodexSession } from './parsers/codex.js';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.js';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from './security.js';

export const api = express();
api.use(express.json());

// ---- Import wizard ----

api.get('/scan', (req, res) => {
  const importedPaths = new Set(db.prepare('SELECT path FROM projects').all().map((p) => p.path));
  const annotate = (items) => items.map((i) => ({ ...i, imported: i.physicalPath ? importedPaths.has(i.physicalPath) : false }));
  res.json({
    'claude-code': annotate(scanClaudeProjects()),
    codex: annotate(scanCodexProjects()),
    cursor: annotate(scanCursorProjects()),
    opencode: annotate(scanOpencodeProjects()),
  });
});

api.post('/import', async (req, res) => {
  const { source, logDir, files, directory } = req.body;
  try {
    // Gather parsed {session, events} pairs per source
    let parsed = [];
    if (source === 'claude-code') {
      if (!logDir || !fs.existsSync(logDir)) return res.status(400).json({ error: 'Log directory not found' });
      const sessionFiles = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(logDir, f));
      for (const f of sessionFiles) parsed.push(await parseClaudeSession(f));
    } else if (source === 'codex') {
      for (const f of (files || []).filter((f) => fs.existsSync(f))) parsed.push(await parseCodexSession(f));
    } else if (source === 'opencode') {
      parsed = parseOpencodeSessions(logDir || OPENCODE_DB, directory);
    } else if (source === 'cursor') {
      if (!logDir || !fs.existsSync(logDir)) return res.status(400).json({ error: 'Workspace directory not found' });
      parsed = parseCursorWorkspace(logDir);
    } else {
      return res.status(400).json({ error: `Unsupported source: ${source}` });
    }

    let imported = 0, skippedSessions = 0, totalMessages = 0;
    let project = null;
    for (const { session, events } of parsed) {
      if (!events.length || !session.cwd) { skippedSessions++; continue; }
      project = upsertProject(session.cwd);
      replaceSession({ ...session, project_id: project.id }, events);
      imported++;
      totalMessages += events.length;
    }
    res.json({ ok: true, imported, skippedSessions, totalMessages, projectId: project?.id ?? null });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
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

api.get('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const sessions = db.prepare(`SELECT id, source, started_at, ended_at, message_count, first_prompt
    FROM sessions WHERE project_id = ? ORDER BY started_at DESC`).all(project.id);
  const toolDist = db.prepare(`SELECT m.tool_name AS name, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND m.kind = 'tool_use' AND m.tool_name IS NOT NULL
    GROUP BY m.tool_name ORDER BY count DESC LIMIT 12`).all(project.id);
  const kindDist = db.prepare(`SELECT m.kind AS kind, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id WHERE s.project_id = ? GROUP BY m.kind`).all(project.id);
  const activity = db.prepare(`SELECT substr(m.ts, 1, 10) AS day, COUNT(*) AS count FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND m.ts IS NOT NULL GROUP BY day ORDER BY day`).all(project.id);
  res.json({ project, sessions, git: gitEngine.repoInfo(project.path), analytics: { toolDist, kindDist, activity } });
});

api.get('/sessions/:id/messages', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(session.id);
  const commits = session.started_at && session.ended_at
    ? gitEngine.commitsBetween(project.path, session.started_at, session.ended_at) : [];
  res.json({ session, project, messages, commits, git: gitEngine.repoInfo(project.path) });
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
