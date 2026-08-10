import fs from 'node:fs';
import path from 'node:path';
import { db, upsertProject, replaceSession } from '../db.js';
import { scanClaudeProjects, parseClaudeSession } from '../parsers/claudeCode.js';
import { scanCodexProjects, parseCodexSession } from '../parsers/codex.js';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from '../parsers/opencode.js';
import { scanCursorProjects, parseCursorWorkspace } from '../parsers/cursor.js';
import { PER_FILE_SOURCES } from './_shared.js';

export function mountImportSync(app) {
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

  app.get('/scan', (req, res) => {
    const { source, dir } = req.query;
    if (source && dir) {
      // Manual directory scan for one source (FR: "Select Directory Manually")
      const scanners = {
        'claude-code': (d) => scanClaudeProjects(d),
        codex: (d) => scanCodexProjects(d),
        opencode: (d) => scanOpencodeProjects(d),
        cursor: (d) => scanCursorProjects(d),
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
    });
  });

  // Gather parsed {session, events} pairs per source. files/sessionIds restrict
  // the import to a user-selected subset of sessions.
  async function gatherParsed({ source, logDir, files, directory, sessionIds, physicalPath }) {
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
      return parseCursorWorkspace(logDir, undefined, physicalPath || null);
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

  app.post('/import', async (req, res) => {
    try {
      res.json(importParsed(await gatherParsed(req.body)));
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  // Re-import every source log location that maps to this project's path (FR: "Sync Update").
  app.post('/projects/:id/sync', async (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    try {
      const bySource = {
        'claude-code': scanClaudeProjects(),
        codex: scanCodexProjects(),
        cursor: scanCursorProjects(),
        opencode: scanOpencodeProjects(),
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

  // Re-import just this one session from its source (per-session "Sync Update").
  app.post('/sessions/:id/sync', async (req, res) => {
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
}
