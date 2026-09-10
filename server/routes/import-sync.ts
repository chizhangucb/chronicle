import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { db, upsertProject, replaceSession } from '../db.ts';
import type { ProjectRow, SessionRow } from '../../shared/rows.ts';
import { SOURCES, sourceById } from '../parsers/registry.ts';
import { importableFiles } from '../parsers/source.ts';
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

// What the import wizard POSTs, and what it gets back: shared/results.ts owns
// both shapes (#307), so the wizard reads the contract this route writes.
import type {
  ImportPayload as GatherParsedParams, ImportProjectAgg as ProjectAgg, ImportResult, ScanResult, SyncRunResult,
} from '../../shared/results.ts';

// Lifted to module scope so the demo seeder can drive the SAME
// parse+import path the HTTP route uses, instead of writing rows into the DB
// directly. They only ever closed over module imports, so this is a pure move.
// Gather parsed {session, events} pairs per source. files/sessionIds restrict
// the import to a user-selected subset of sessions.
export async function gatherParsed(target: GatherParsedParams): Promise<ParseResult[]> {
  const source = sourceById(target.source);
  if (!source) throw bad(`Unsupported source: ${target.source}`);
  return source.parse(target);
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
      // Manual directory scan for one source (FR: "Select Directory Manually").
      // Also how the E2E harness and the seeded walk point a scan at a
      // generated fixture dir instead of the machine's real logs.
      const one = sourceById(source);
      if (!one) return res.status(400).json({ error: `Unsupported source: ${source}` });
      if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Directory not found' });
      try { return res.json({ [source]: annotateScan(one.scan(dir)) }); }
      catch (err) { return res.status(500).json({ error: errMessage(err) }); }
    }
    // Every source at its own default root.
    const scan = Object.fromEntries(SOURCES.map((s) => [s.id, annotateScan(s.scan())])) as ScanResult;
    res.json(scan);
  });

  app.post('/import', async (req: Request, res: Response) => {
    try {
      const body: GatherParsedParams = { ...req.body };
      // Test-only: a CHRONICLE_E2E-gated `?dir=` override, so a harness can
      // seed an import without a body `logDir` — a plain `POST /import` with
      // `?dir=<fixtureDir>` is enough. Only fills a MISSING body.logDir; a
      // caller-supplied logDir always wins. Airtight in production, where the
      // env var is never set.
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
      const matches = SOURCES.flatMap((s) => s.scan()).filter((i) => i.physicalPath === project.path);
      if (!matches.length) return res.status(404).json({ error: 'No source logs found for this project path' });
      let imported = 0, skippedSessions = 0, totalMessages = 0;
      for (const item of matches) {
        const result = importParsed(await gatherParsed(item));
        imported += result.imported;
        skippedSessions += result.skippedSessions;
        totalMessages += result.totalMessages;
      }
      const synced: SyncRunResult = { ok: true, imported, skippedSessions, totalMessages, sources: matches.map((m) => m.source) };
      res.json(synced);
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
      const source = sourceById(session.source);
      const matches = (source?.scan() ?? []).filter((i) => i.physicalPath === project.path);
      if (!matches.length) return res.status(404).json({ error: 'No source logs found for this session' });
      let imported = 0, totalMessages = 0;
      for (const item of matches) {
        // Restrict the parse to this session's file where the scan lists it:
        // a per-file source names one transcript per session, a store-backed
        // one names none and has to be re-parsed whole.
        const scoped: GatherParsedParams = session.file_path && importableFiles(item).includes(session.file_path)
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
