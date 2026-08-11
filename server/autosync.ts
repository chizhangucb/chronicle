// Invisible auto-sync: keep the DB fresh without manual syncs.
// Triggers: server start, a 30-min backstop timer, and a debounced (~30 s)
// fs-watch on the known source log dirs. Incremental:
// only sessions whose source file mtime is newer than their last import are
// re-parsed; `replaceSession` is idempotent, so partial in-progress imports are
// simply superseded by the next pass. State lives on globalThis so Vite SSR
// module reloads don't orphan watchers/timers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db, upsertProject, replaceSession } from './db.ts';
import { scanClaudeProjects, parseClaudeSession, CLAUDE_PROJECTS_DIR } from './parsers/claudeCode.ts';
import { scanCodexProjects, parseCodexSession, CODEX_SESSIONS_DIR } from './parsers/codex.ts';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.ts';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.ts';
import type { ParseResult } from '../shared/types.ts';

export interface ChronicleConfig {
  autoSync?: boolean;
  autoSyncPaused?: boolean;
  [key: string]: unknown;
}

export type ConfigPatch = Partial<ChronicleConfig>;

export interface SyncResultOk {
  ok: true;
  imported: number;
  checked: number;
  ms: number;
}
export interface SyncResultSkipped {
  ok: true;
  skipped: string;
}
export interface SyncResultError {
  ok: false;
  error: string;
}
export type SyncResult = SyncResultOk | SyncResultSkipped | SyncResultError;

interface AutoSyncState {
  watchers: fs.FSWatcher[];
  timer: NodeJS.Timeout | null;
  debounce: NodeJS.Timeout | null;
  running: boolean;
  lastRun: string | null;
  lastResult: SyncResult | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleAutoSync: AutoSyncState | undefined;
}

const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
const CONFIG_PATH = path.join(CHRONICLE_DIR, 'config.json');
const DEBOUNCE_MS = 30 * 1000;       // a streaming JSONL isn't re-imported per line
const BACKSTOP_MS = 30 * 60 * 1000;  // catches missed fs events (macOS drops them across sleep)

export function readConfig(): ChronicleConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

export function writeConfig(patch: ConfigPatch): ChronicleConfig {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(CHRONICLE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function autoSyncEnabled(): boolean {
  return readConfig().autoSync !== false; // default ON
}

// Pause: distinct from autoSync's on/off. Off tears down the watchers/timer
// entirely (startAutoSync early-returns); paused keeps them registered (so
// resuming needs no restart) but every sync attempt they trigger — the
// debounced fs-watch handler AND the 30-min backstop timer, both of which
// funnel through runIncrementalSync — no-ops. Manual actions (Sync Update
// buttons, single-session sync) call importParsed directly, not
// runIncrementalSync, so pause never blocks an explicit user sync.
export function autoSyncPaused(): boolean {
  return readConfig().autoSyncPaused === true; // default OFF
}

function state(): AutoSyncState {
  if (!globalThis.__chronicleAutoSync) {
    globalThis.__chronicleAutoSync = { watchers: [], timer: null, debounce: null, running: false, lastRun: null, lastResult: null };
  }
  return globalThis.__chronicleAutoSync;
}

function mtimeOf(file: string): number | null {
  try { return fs.statSync(file).mtime.getTime(); } catch { return null; }
}

// A Claude Code session's effective mtime includes its subagents dir.
function claudeMtime(file: string): number | null {
  let m = mtimeOf(file) ?? 0;
  const sub = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  try {
    for (const f of fs.readdirSync(sub)) m = Math.max(m, mtimeOf(path.join(sub, f)) ?? 0);
  } catch {}
  return m || null;
}

// One incremental pass over every source. Imports sessions that are NEW in an
// already-imported project, or whose source file changed since their import.
export async function runIncrementalSync(): Promise<SyncResult> {
  const st = state();
  if (st.running) return { ok: true, skipped: 'already running' };
  if (autoSyncPaused()) return { ok: true, skipped: 'paused' };
  st.running = true;
  const started = Date.now();
  let imported = 0, checked = 0;
  try {
    const projectPaths = new Set((db.prepare('SELECT path FROM projects').all() as unknown as { path: string }[]).map((p) => p.path));
    const bySession = new Map((db.prepare('SELECT id, file_path, imported_at FROM sessions').all() as unknown as { id: string; file_path: string; imported_at: string | null }[]).map((s) => [s.id, s]));
    const byFile = new Map((db.prepare('SELECT file_path, MAX(imported_at) AS at FROM sessions GROUP BY file_path').all() as unknown as { file_path: string; at: string | null }[]).map((r) => [r.file_path, r.at]));
    const importedAtMs = (iso: string | null | undefined): number => (iso ? new Date(iso + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z')).getTime() : 0);

    const importParsedList = (parsed: ParseResult[]): void => {
      for (const { session, events } of parsed) {
        if (!events.length || !session.cwd) continue;
        if (!projectPaths.has(session.cwd)) continue; // auto-sync never creates new projects
        const project = upsertProject(session.cwd);
        replaceSession({ ...session, project_id: project.id }, events);
        imported++;
      }
    };

    // Per-file sources: cheap mtime pre-filter, parse only stale/new files.
    for (const item of scanClaudeProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath)) continue;
      for (const s of item.sessions ?? []) {
        checked++;
        const prev = bySession.get(s.id);
        const m = claudeMtime(s.file as string);
        if (prev && m && m <= importedAtMs(prev.imported_at)) continue;
        importParsedList([await parseClaudeSession(s.file as string)]);
      }
    }
    for (const item of scanCodexProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath)) continue;
      for (const f of item.files ?? []) {
        checked++;
        const at = byFile.get(f);
        const m = mtimeOf(f);
        if (at && m && m <= importedAtMs(at)) continue;
        importParsedList([await parseCodexSession(f)]);
      }
    }
    // DB-backed / dir-backed sources: re-parse the whole store when its file is
    // newer than the last import from it.
    const staleStore = (storePath: string): boolean => {
      const at = [...byFile.entries()].filter(([f]) => f === storePath || f.startsWith(storePath)).map(([, v]) => v).sort().pop();
      const m = mtimeOf(storePath);
      return !at || !m || m > importedAtMs(at);
    };
    for (const item of scanOpencodeProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath)) continue;
      checked++;
      if (staleStore(OPENCODE_DB)) importParsedList(await parseOpencodeSessions(OPENCODE_DB, item.directory));
    }
    for (const item of scanCursorProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath) || !item.logDir) continue;
      checked++;
      if (staleStore(item.logDir)) importParsedList(await parseCursorWorkspace(item.logDir, undefined, item.physicalPath));
    }
    st.lastResult = { ok: true, imported, checked, ms: Date.now() - started };
  } catch (err) {
    st.lastResult = { ok: false, error: String((err as Error).message || err) };
  } finally {
    st.lastRun = new Date().toISOString();
    st.running = false;
  }
  return st.lastResult as SyncResult;
}

export function autoSyncStatus(): { enabled: boolean; running: boolean; lastRun: string | null; lastResult: SyncResult | null } {
  const st = state();
  return { enabled: autoSyncEnabled(), running: st.running, lastRun: st.lastRun, lastResult: st.lastResult };
}

function scheduleDebounced(): void {
  const st = state();
  clearTimeout(st.debounce ?? undefined);
  st.debounce = setTimeout(() => { runIncrementalSync(); }, DEBOUNCE_MS);
}

export function startAutoSync(): void {
  const st = state();
  stopAutoSync();
  if (!autoSyncEnabled()) return;
  // fs-watch the known source dirs (recursive works on macOS/Windows; a dir that
  // doesn't exist or can't be watched is skipped — the timer is the backstop).
  const cursorDirs = scanCursorProjects().map((i) => i.logDir).filter(Boolean);
  const dirs = [CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, path.dirname(OPENCODE_DB), ...cursorDirs];
  for (const d of new Set(dirs)) {
    try {
      if (!fs.existsSync(d)) continue;
      const w = fs.watch(d, { recursive: true }, () => scheduleDebounced());
      w.on('error', () => {});
      st.watchers.push(w);
    } catch {}
  }
  st.timer = setInterval(() => { runIncrementalSync(); }, BACKSTOP_MS);
  // Sync on start (also covers "server restarted after sleep/quit").
  setTimeout(() => { runIncrementalSync(); }, 3000);
}

export function stopAutoSync(): void {
  const st = state();
  for (const w of st.watchers.splice(0)) { try { w.close(); } catch {} }
  clearInterval(st.timer ?? undefined); st.timer = null;
  clearTimeout(st.debounce ?? undefined); st.debounce = null;
}
