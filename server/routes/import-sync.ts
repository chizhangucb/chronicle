import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { db, upsertProject, replaceSession, type ProjectRow, type SessionRow } from '../db.ts';
import { scanClaudeProjects, parseClaudeSession } from '../parsers/claudeCode.ts';
import { scanCodexProjects, parseCodexSession } from '../parsers/codex.ts';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from '../parsers/opencode.ts';
import { scanCursorProjects, parseCursorWorkspace } from '../parsers/cursor.ts';
import { PER_FILE_SOURCES } from './_shared.ts';
import type { ParseResult, ScannedProject } from '../../shared/types.ts';

interface StatusError extends Error {
  status?: number;
}

function bad(msg: string): StatusError {
  const e = new Error(msg) as StatusError;
  e.status = 400;
  return e;
}

function errStatus(err: unknown): number {
  return (err as StatusError)?.status || 500;
}
function errMessage(err: unknown): string {
  return String((err as Error)?.message || err);
}

interface GatherParsedParams {
  source: string;
  logDir?: string | null;
  files?: string[];
  directory?: string;
  sessionIds?: string[];
  physicalPath?: string | null;
}

interface ProjectAgg {
  id: number;
  name: string;
  path: string;
  created: boolean;
  sessions: number;
  messages: number;
}

interface ImportResult {
  ok: true;
  imported: number;
  skippedSessions: number;
  totalMessages: number;
  projects: ProjectAgg[];
  projectId: number | null;
}

// Lifted to module scope (CHI-325 3c) so the demo seeder can drive the SAME
// parse+import path the HTTP route uses, instead of writing rows into the DB
// directly. They only ever closed over module imports, so this is a pure move.
// Gather parsed {session, events} pairs per source. files/sessionIds restrict
// the import to a user-selected subset of sessions.
export async function gatherParsed({ source, logDir, files, directory, sessionIds, physicalPath }: GatherParsedParams): Promise<ParseResult[]> {
  if (source === 'claude-code') {
    if (!logDir || !fs.existsSync(logDir)) throw bad('Log directory not found');
    const sessionFiles = files?.length
      ? files.filter((f) => fs.existsSync(f))
      : fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(logDir, f));
    const parsed: ParseResult[] = [];
    for (const f of sessionFiles) parsed.push(await parseClaudeSession(f));
    return parsed;
  }
  if (source === 'codex') {
    const parsed: ParseResult[] = [];
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
export function importParsed(parsed: ParseResult[]): ImportResult {
  let imported = 0, skippedSessions = 0, totalMessages = 0;
  const byProject = new Map<number, ProjectAgg>();
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

export function mountImportSync(app: Express): void {
  // ---- Import wizard ----

  function annotateScan(items: ScannedProject[]) {
    const importedPaths = new Set((db.prepare('SELECT path FROM projects').all() as unknown as ProjectRow[]).map((p) => p.path));
    const importedIds = new Set((db.prepare('SELECT id FROM sessions').all() as unknown as { id: string }[]).map((s) => s.id));
    const importedFiles = new Set((db.prepare('SELECT file_path FROM sessions').all() as unknown as { file_path: string }[]).map((s) => s.file_path));
    return items.map((i) => ({
      ...i,
      imported: i.physicalPath ? importedPaths.has(i.physicalPath) : false,
      sessions: i.sessions?.map((s) => ({
        ...s,
        imported: importedIds.has(s.id) || (s.file ? importedFiles.has(s.file) : false),
      })),
    }));
  }

  app.get('/scan', (req: Request, res: Response) => {
    const { source, dir } = req.query as { source?: string; dir?: string };
    if (source && dir) {
      // Manual directory scan for one source (FR: "Select Directory Manually")
      const scanners: Record<string, (d: string) => ScannedProject[]> = {
        'claude-code': (d) => scanClaudeProjects(d),
        codex: (d) => scanCodexProjects(d),
        opencode: (d) => scanOpencodeProjects(d),
        cursor: (d) => scanCursorProjects(d),
      };
      if (!scanners[source]) return res.status(400).json({ error: `Unsupported source: ${source}` });
      if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Directory not found' });
      try { return res.json({ [source]: annotateScan(scanners[source](dir)) }); }
      catch (err) { return res.status(500).json({ error: errMessage(err) }); }
    }
    // Test-only: the E2E harness (test/e2e/helpers.ts) points the DEFAULT
    // claude-code scan at a generated fixture dir instead of the real
    // CLAUDE_PROJECTS_DIR, so it can seed a big fixture session without
    // touching the machine's real Claude Code logs. `dir` alone (no `source`)
    // is a no-op unless CHRONICLE_E2E=1 — airtight in production, where the
    // env var is never set.
    const e2eClaudeDir = process.env.CHRONICLE_E2E === '1' && dir ? dir : undefined;
    res.json({
      'claude-code': annotateScan(scanClaudeProjects(e2eClaudeDir)),
      codex: annotateScan(scanCodexProjects()),
      cursor: annotateScan(scanCursorProjects()),
      opencode: annotateScan(scanOpencodeProjects()),
    });
  });

  app.post('/import', async (req: Request, res: Response) => {
    try {
      const body: GatherParsedParams = { ...req.body };
      // Test-only: same CHRONICLE_E2E-gated `?dir=` override as GET /scan
      // above, so the E2E harness can seed an import without a body `logDir`
      // — a plain `POST /import` with `?dir=<fixtureDir>` is enough. Only
      // fills a MISSING body.logDir; a caller-supplied logDir always wins.
      if (process.env.CHRONICLE_E2E === '1' && !body.logDir && typeof req.query.dir === 'string') {
        body.logDir = req.query.dir;
      }
      res.json(importParsed(await gatherParsed(body)));
    } catch (err) {
      res.status(errStatus(err)).json({ error: errMessage(err) });
    }
  });

  // Re-import every source log location that maps to this project's path (FR: "Sync Update").
  app.post('/projects/:id/sync', async (req: Request, res: Response) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get((req.params.id as string)) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Not found' });
    try {
      const bySource: Record<string, ScannedProject[]> = {
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
      res.status(errStatus(err)).json({ error: errMessage(err) });
    }
  });

  // Re-import just this one session from its source (per-session "Sync Update").
  app.post('/sessions/:id/sync', async (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params.id as string)) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id) as ProjectRow | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const bySource: Record<string, ScannedProject[]> = {
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
        const scoped: GatherParsedParams = PER_FILE_SOURCES.has(session.source) && session.file_path
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
      res.status(errStatus(err)).json({ error: errMessage(err) });
    }
  });
}
