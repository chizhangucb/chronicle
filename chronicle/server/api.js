import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, upsertProject, replaceSession } from './db.js';
import { scanClaudeProjects, parseClaudeSession } from './parsers/claudeCode.js';
import { scanCodexProjects, parseCodexSession } from './parsers/codex.js';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.js';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.js';
import { scanGeminiProjects, parseGeminiProject } from './parsers/gemini.js';
import { analyzeCausality } from './causality.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from './security.js';
import { classifyScan, backupSources, listServices, upsertService, setServiceEnabled, deleteService, maskService, setDisabledTools } from './mcp/registry.js';
import { hubStatus, hubLog, callTool, aggregateTools } from './mcp/hub.js';
import * as skills from './skills.js';
import { attachLiveStream, isLiveCandidate, liveStatus } from './live.js';
import * as replay from './replay.js';

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
    'gemini-cli': annotate(scanGeminiProjects()),
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
    } else if (source === 'gemini-cli') {
      if (!logDir || !fs.existsSync(logDir)) return res.status(400).json({ error: 'Gemini project directory not found' });
      parsed = parseGeminiProject(logDir);
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
  res.json({ session, project, messages, commits, git: gitEngine.repoInfo(project.path),
    liveCandidate: isLiveCandidate(session.file_path) });
});

// ---- Live streaming (FR-LS): SSE tail of the session's log file ----

api.get('/sessions/:id/live', (req, res) => {
  if (!attachLiveStream(req.params.id, res)) {
    res.status(400).json({ error: 'Live streaming unavailable for this session (missing file or SQLite source)' });
  }
});
api.get('/live/status', (req, res) => res.json(liveStatus()));

// ---- Replay Mode (FR-RP): deterministic sandbox re-execution ----

api.get('/sessions/:id/replay-plan', (req, res) => {
  try { res.json(replay.buildPlan(req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/replay/start', (req, res) => {
  try { res.json(replay.startReplay(req.body.sessionId, req.body.workspace)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/replay/step', (req, res) => {
  try { res.json(replay.executeStep(req.body.sessionId, req.body.seq, { confirmCommand: !!req.body.confirmCommand })); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.get('/replay/preview', (req, res) => {
  try { res.json(replay.previewStep(req.query.sessionId, Number(req.query.seq))); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/replay/open', (req, res) => {
  try { replay.openWorkspace(req.body.sessionId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

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

// ---- MCP Hub (FR-MCP) ----

api.get('/mcp/services', (req, res) => res.json(listServices().map(maskService)));
api.get('/mcp/scan', (req, res) => res.json(classifyScan().map((i) => maskService({ ...i, env: i.env, headers: i.headers }))));
api.post('/mcp/takeover', (req, res) => {
  try {
    const backupDir = backupSources();
    const wanted = new Set(req.body.names || []);
    const items = classifyScan().filter((i) => wanted.has(i.name));
    for (const item of items) upsertService(item);
    res.json({ ok: true, imported: items.length, backupDir, services: listServices().map(maskService) });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/mcp/services', (req, res) => {
  try {
    const { name, transport, command, args, env, url, headers } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    upsertService({ name, transport: transport || (url ? 'http' : 'stdio'), command: command ?? null,
      args: JSON.stringify(args ?? []), env: JSON.stringify(env ?? {}), url: url ?? null,
      headers: JSON.stringify(headers ?? {}), origin: 'manual' });
    res.json(listServices().map(maskService));
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.patch('/mcp/services/:id', (req, res) => {
  if (req.body.enabled !== undefined) setServiceEnabled(req.params.id, !!req.body.enabled);
  if (req.body.disabledTools !== undefined) setDisabledTools(req.params.id, req.body.disabledTools);
  res.json(listServices().map(maskService));
});
api.delete('/mcp/services/:id', (req, res) => { deleteService(req.params.id); res.json(listServices().map(maskService)); });
api.get('/mcp/status', (req, res) => res.json(hubStatus()));
api.get('/mcp/log', (req, res) => res.json(hubLog()));
api.get('/mcp/tools', async (req, res) => res.json(await aggregateTools()));
api.post('/mcp/call', async (req, res) => {
  try { res.json({ ok: true, result: await callTool(req.body.name, req.body.arguments) }); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// ---- Skills Hub (FR-SK) ----

api.get('/skills', (req, res) => res.json(skills.listSkills()));
api.get('/skills/scan', (req, res) => res.json(skills.scanSkills()));
api.post('/skills/import', (req, res) => {
  try { res.json({ ok: true, skill: skills.importSkill(req.body.path, req.body.origin) }); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.get('/skills/:id', (req, res) => {
  const s = skills.skillContent(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: 'Not found' });
});
api.post('/skills/:id/link', (req, res) => {
  try { skills.linkSkill(req.params.id, req.body.tool); res.json(skills.listSkills()); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/skills/:id/unlink', (req, res) => {
  try { skills.unlinkSkill(req.params.id, req.body.tool); res.json(skills.listSkills()); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.patch('/skills/:id', (req, res) => { skills.updateSkillMeta(req.params.id, req.body); res.json(skills.listSkills()); });
api.delete('/skills/:id', (req, res) => { skills.deleteSkill(req.params.id, req.query.removeFiles === '1'); res.json(skills.listSkills()); });

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
