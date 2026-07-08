import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, upsertProject, replaceSession } from './db.js';
import { scanClaudeProjects, parseClaudeSession } from './parsers/claudeCode.js';
import { scanCodexProjects, parseCodexSession } from './parsers/codex.js';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.js';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.js';
import { scanGeminiProjects, parseGeminiProject } from './parsers/gemini.js';
import { analyzeCausality } from './causality.js';
import * as gitEngine from './git.js';
import { scanSession, listRules, addRule, deleteRule, toggleRule, preToolUseCheck, listInterceptions } from './security.js';
import { createShare, listShares, revokeShare } from './shares.js';
import { scanCopilotProjects, parseCopilotWorkspace } from './parsers/copilot.js';
import { classifyScan, backupSources, listServices, upsertService, setServiceEnabled, deleteService, maskService, setDisabledTools, setProjectPath, setCredential } from './mcp/registry.js';
import { hubStatus, hubLog, callTool, aggregateTools } from './mcp/hub.js';
import * as skills from './skills.js';
import { attachLiveStream, isLiveCandidate, liveStatus } from './live.js';
import * as replay from './replay.js';

export const api = express();
api.use(express.json());

// ---- Import wizard ----

function annotateScan(items) {
  const importedPaths = new Set(db.prepare('SELECT path FROM projects').all().map((p) => p.path));
  const importedIds = new Set(db.prepare('SELECT id FROM sessions').all().map((s) => s.id));
  const importedFiles = new Set(db.prepare('SELECT file_path FROM sessions').all().map((s) => s.file_path));
  return items.map((i) => ({
    ...i,
    imported: i.physicalPath ? importedPaths.has(i.physicalPath) : false,
    sessions: i.sessions?.map((s) => ({
      ...s,
      imported: importedIds.has(s.id) || (s.file ? importedFiles.has(s.file) : false),
    })),
  }));
}

api.get('/scan', (req, res) => {
  const { source, dir } = req.query;
  if (source && dir) {
    // Manual directory scan for one source (FR: "Select Directory Manually")
    const scanners = {
      'claude-code': (d) => scanClaudeProjects(d),
      codex: (d) => scanCodexProjects(d),
      opencode: (d) => scanOpencodeProjects(d),
      cursor: (d) => scanCursorProjects(d),
      'gemini-cli': (d) => scanGeminiProjects(d),
      'copilot-chat': (d) => scanCopilotProjects([d]),
    };
    if (!scanners[source]) return res.status(400).json({ error: `Unsupported source: ${source}` });
    if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Directory not found' });
    try { return res.json({ [source]: annotateScan(scanners[source](dir)) }); }
    catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
  }
  res.json({
    'claude-code': annotateScan(scanClaudeProjects()),
    codex: annotateScan(scanCodexProjects()),
    cursor: annotateScan(scanCursorProjects()),
    opencode: annotateScan(scanOpencodeProjects()),
    'gemini-cli': annotateScan(scanGeminiProjects()),
    'copilot-chat': annotateScan(scanCopilotProjects()),
  });
});

// Gather parsed {session, events} pairs per source. files/sessionIds restrict
// the import to a user-selected subset of sessions.
async function gatherParsed({ source, logDir, files, directory, sessionIds }) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  if (source === 'claude-code') {
    if (!logDir || !fs.existsSync(logDir)) throw bad('Log directory not found');
    const sessionFiles = files?.length
      ? files.filter((f) => fs.existsSync(f))
      : fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(logDir, f));
    const parsed = [];
    for (const f of sessionFiles) parsed.push(await parseClaudeSession(f));
    return parsed;
  }
  if (source === 'codex') {
    const parsed = [];
    for (const f of (files || []).filter((f) => fs.existsSync(f))) parsed.push(await parseCodexSession(f));
    return parsed;
  }
  if (source === 'opencode') return parseOpencodeSessions(logDir || OPENCODE_DB, directory, sessionIds);
  if (source === 'cursor') {
    if (!logDir || !fs.existsSync(logDir)) throw bad('Workspace directory not found');
    return parseCursorWorkspace(logDir);
  }
  if (source === 'gemini-cli') {
    if (!logDir || !fs.existsSync(logDir)) throw bad('Gemini project directory not found');
    return parseGeminiProject(logDir);
  }
  if (source === 'copilot-chat') {
    if (!logDir || !fs.existsSync(logDir)) throw bad('Workspace directory not found');
    return parseCopilotWorkspace(logDir);
  }
  throw bad(`Unsupported source: ${source}`);
}

// Import parsed sessions; reports per-project aggregates so the UI can show
// which projects were created vs updated.
function importParsed(parsed) {
  let imported = 0, skippedSessions = 0, totalMessages = 0;
  const byProject = new Map();
  for (const { session, events } of parsed) {
    if (!events.length || !session.cwd) { skippedSessions++; continue; }
    const existed = !!db.prepare('SELECT id FROM projects WHERE path = ?').get(session.cwd);
    const project = upsertProject(session.cwd);
    replaceSession({ ...session, project_id: project.id }, events);
    imported++;
    totalMessages += events.length;
    const agg = byProject.get(project.id)
      || { id: project.id, name: project.name, path: project.path, created: !existed, sessions: 0, messages: 0 };
    agg.sessions++;
    agg.messages += events.length;
    byProject.set(project.id, agg);
  }
  const projects = [...byProject.values()];
  return { ok: true, imported, skippedSessions, totalMessages, projects, projectId: projects[0]?.id ?? null };
}

api.post('/import', async (req, res) => {
  try {
    res.json(importParsed(await gatherParsed(req.body)));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// Re-import every source log location that maps to this project's path (FR: "Sync Update").
api.post('/projects/:id/sync', async (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  try {
    const bySource = {
      'claude-code': scanClaudeProjects(),
      codex: scanCodexProjects(),
      cursor: scanCursorProjects(),
      opencode: scanOpencodeProjects(),
      'gemini-cli': scanGeminiProjects(),
      'copilot-chat': scanCopilotProjects(),
    };
    const matches = Object.values(bySource).flat().filter((i) => i.physicalPath === project.path);
    if (!matches.length) return res.status(404).json({ error: 'No source logs found for this project path' });
    let imported = 0, skippedSessions = 0, totalMessages = 0;
    for (const item of matches) {
      const result = importParsed(await gatherParsed(item));
      imported += result.imported;
      skippedSessions += result.skippedSessions;
      totalMessages += result.totalMessages;
    }
    res.json({ ok: true, imported, skippedSessions, totalMessages, sources: matches.map((m) => m.source) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// ---- Feedback ----
// Sends via the Resend email API, and always writes a local copy to
// ~/.chronicle/feedback.log FIRST (the app's one deliberate outbound feature
// besides the update check and user-initiated GitHub imports).
//
// The Resend API key is a SECRET — it is read from ~/.chronicle/config.json (or
// env), never committed or shipped in the app bundle (this repo is public). With
// no key configured the endpoint fails soft: the feedback is still logged locally
// and the UI falls back to a mailto: draft.
const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');

// { resendApiKey, feedbackTo, feedbackFrom } from ~/.chronicle/config.json, env wins.
function feedbackConfig() {
  let cfg = {};
  try {
    const p = path.join(CHRONICLE_DIR, 'config.json');
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {
    apiKey: process.env.RESEND_API_KEY || cfg.resendApiKey || null,
    to: process.env.FEEDBACK_TO || cfg.feedbackTo || 'chizhangucb@gmail.com',
    // Resend's shared onboarding@resend.dev works with no domain setup, but only
    // delivers to the Resend account owner's address. Verify a domain and set
    // feedbackFrom (e.g. "Chronicle <feedback@yourdomain>") to reach any inbox.
    from: process.env.FEEDBACK_FROM || cfg.feedbackFrom || 'Chronicle Feedback <onboarding@resend.dev>',
  };
}

api.post('/feedback', async (req, res) => {
  const message = (req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Feedback is empty' });
  const entry = { ts: new Date().toISOString(), platform: process.platform, message };
  try {
    fs.mkdirSync(CHRONICLE_DIR, { recursive: true });
    fs.appendFileSync(path.join(CHRONICLE_DIR, 'feedback.log'), JSON.stringify(entry) + '\n');
  } catch {}
  const { apiKey, to, from } = feedbackConfig();
  if (!apiKey) {
    return res.status(502).json({ error: 'Feedback email is not configured (add "resendApiKey" to ~/.chronicle/config.json) — feedback saved locally' });
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to, subject: 'Chronicle feedback',
        text: `${message}\n\n— platform: ${process.platform}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    // Resend returns { id } on success, or a non-2xx with { name, message } / { error }.
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) {
      throw new Error(body.error?.message || body.message || `resend ${r.status}`);
    }
    res.json({ ok: true, id: body.id });
  } catch (err) {
    res.status(502).json({ error: `Email relay unreachable (${String(err.message || err)}) — feedback saved locally` });
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

// Heuristic error detection (mirrors the client-side Overview heuristic).
const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;

api.get('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Optional time range (?days=7/30/365) — filters sessions and all analytics.
  const days = Number(req.query.days) || null;
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const sessions = db.prepare(`SELECT id, source, file_path, started_at, ended_at, message_count, first_prompt, name, summary, context_tokens,
      (SELECT SUM(LENGTH(COALESCE(m.text, '')) + LENGTH(COALESCE(m.tool_input, '')))
       FROM messages m WHERE m.session_id = sessions.id) AS char_count
    FROM sessions WHERE project_id = ? AND COALESCE(started_at, '9') >= ? ORDER BY started_at DESC`).all(project.id, cutoff)
    .map(({ file_path, ...s }) => ({ ...s, liveCandidate: isLiveCandidate(file_path) }));
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

// Re-import just this one session from its source (per-session "Sync Update").
api.post('/sessions/:id/sync', async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const bySource = {
      'claude-code': scanClaudeProjects(),
      codex: scanCodexProjects(),
      cursor: scanCursorProjects(),
      opencode: scanOpencodeProjects(),
      'gemini-cli': scanGeminiProjects(),
      'copilot-chat': scanCopilotProjects(),
    };
    const matches = (bySource[session.source] || [])
      .filter((i) => i.physicalPath === project.path);
    if (!matches.length) return res.status(404).json({ error: 'No source logs found for this session' });
    let imported = 0, totalMessages = 0;
    for (const item of matches) {
      // Restrict the parse to this session's file where the source is per-file.
      const scoped = PER_FILE_SOURCES.has(session.source) && session.file_path
        ? { ...item, files: [session.file_path] } : item;
      const parsed = (await gatherParsed(scoped)).filter((p) => p.session.id === session.id);
      if (!parsed.length) continue;
      const result = importParsed(parsed);
      imported += result.imported;
      totalMessages += result.totalMessages;
    }
    if (!imported) return res.status(404).json({ error: 'This session was not found in the current source logs' });
    res.json({ ok: true, imported, totalMessages });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
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

  const like = `%${q}%`;
  const where = ['(m.text LIKE ? OR m.tool_input LIKE ?)'];
  const params = [like, like];
  if (kinds) { where.push(`m.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
  if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
  if (cutoff) { where.push("COALESCE(s.started_at, '9') >= ?"); params.push(cutoff); }
  const rows = db.prepare(`SELECT m.session_id, m.seq, m.kind, m.text, m.tool_name, m.tool_input, m.ts,
      s.project_id, s.source, s.name, s.summary, s.first_prompt, p.name AS project_name
    FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.ts DESC LIMIT 400`).all(...params);

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
  res.json({ session, project, messages, commits, git: gitEngine.repoInfo(project.path),
    liveCandidate: isLiveCandidate(session.file_path) });
});

// Delete the ORIGINAL log file on disk (explicit user request only, permanent —
// the UI double-confirms). Restricted to sources where one file == one session;
// shared stores (OpenCode/Cursor DBs, Gemini logDirs) would lose other sessions.
const PER_FILE_SOURCES = new Set(['claude-code', 'codex', 'copilot-chat']);

api.delete('/sessions/:id/source-file', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (!PER_FILE_SOURCES.has(session.source)) {
    return res.status(400).json({ error: `${session.source} keeps sessions in shared storage — deleting the file would remove other sessions too` });
  }
  if (!fs.existsSync(session.file_path) || !fs.statSync(session.file_path).isFile()) {
    return res.status(400).json({ error: 'Source file no longer exists on disk' });
  }
  if (isLiveCandidate(session.file_path)) {
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
  if (isLiveCandidate(session.file_path)) {
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

// Pre-tool-use interception (FR-SEC-5/6) — called by hooks/chronicle-guard.mjs
api.post('/security/pretooluse', (req, res) => {
  try {
    res.json(preToolUseCheck(req.body, (p) => {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).size > 2 * 1024 * 1024) return null;
        return fs.readFileSync(p, 'utf8');
      } catch { return null; }
    }));
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.get('/security/interceptions', (req, res) => res.json(listInterceptions()));

// Hook installer — explicit user action; backs up settings first.
api.post('/security/install-hook', (req, res) => {
  try {
    const os = process.env.HOME || process.env.USERPROFILE;
    const settingsPath = path.join(os, '.claude', 'settings.json');
    const guardPath = path.resolve(import.meta.dirname, '..', 'hooks', 'chronicle-guard.mjs');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      fs.mkdirSync(path.join(os, '.chronicle', 'backups', 'hooks'), { recursive: true });
      const backup = path.join(os, '.chronicle', 'backups', 'hooks', `settings-${Date.now()}.json`);
      fs.copyFileSync(settingsPath, backup);
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const command = `node "${guardPath}"`;
    const already = JSON.stringify(settings.hooks.PreToolUse).includes('chronicle-guard');
    if (!already) {
      settings.hooks.PreToolUse.push({ matcher: 'Read|Grep|Bash|WebFetch', hooks: [{ type: 'command', command }] });
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
    res.json({ ok: true, installed: !already, settingsPath, command });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// Share links (FR-SEC-8)
api.post('/sessions/:id/share', (req, res) => {
  try { res.json(createShare(req.params.id, req.body?.days ?? 7)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.get('/shares', (req, res) => res.json(listShares()));
api.delete('/shares/:id', (req, res) => { revokeShare(req.params.id); res.json(listShares()); });

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
  if (req.body.projectPath !== undefined) setProjectPath(req.params.id, req.body.projectPath);
  if (req.body.bearer !== undefined) setCredential(req.params.id, req.body.bearer);
  res.json(listServices().map(maskService));
});
api.delete('/mcp/services/:id', (req, res) => { deleteService(req.params.id); res.json(listServices().map(maskService)); });
api.get('/mcp/status', (req, res) => res.json(hubStatus()));
api.get('/mcp/log', (req, res) => res.json(hubLog()));
api.get('/mcp/tools', async (req, res) => res.json(await aggregateTools('*')));
api.post('/mcp/call', async (req, res) => {
  try { res.json({ ok: true, result: await callTool(req.body.name, req.body.arguments) }); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// ---- Skills Hub (FR-SK) ----

api.get('/skills', (req, res) => res.json(skills.listSkills()));
api.get('/skills/scan', (req, res) => res.json(skills.scanSkills()));
api.post('/skills/import', (req, res) => {
  try {
    const skill = skills.importSkill(req.body.path, req.body.origin);
    skills.takeSnapshot(skill.id, 'imported');
    res.json({ ok: true, skill });
  }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/skills/github', (req, res) => {
  try { res.json(skills.importFromGithub(req.body.url, req.body.branch || 'main', req.body.subpath || '')); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.get('/skills/:id/snapshots', (req, res) => res.json(skills.listSnapshots(req.params.id)));
api.post('/skills/:id/restore', (req, res) => {
  try { res.json(skills.restoreSnapshot(req.params.id, req.body.snapshotId)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
api.post('/skills/:id/check-upstream', (req, res) => {
  try { res.json(skills.checkUpstream(req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
skills.startSkillWatcher();
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
