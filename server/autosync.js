// Tray auto-sync (design doc Phase 2): keep the DB fresh without manual syncs.
// Triggers: server start, a 30-min backstop timer, a debounced (~30 s) fs-watch
// on the known source log dirs, and (from Electron) system wake. Incremental:
// only sessions whose source file mtime is newer than their last import are
// re-parsed; `replaceSession` is idempotent, so partial in-progress imports are
// simply superseded by the next pass. State lives on globalThis so Vite SSR
// module reloads don't orphan watchers/timers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db, upsertProject, replaceSession } from './db.js';
import { scanClaudeProjects, parseClaudeSession, CLAUDE_PROJECTS_DIR } from './parsers/claudeCode.js';
import { scanCodexProjects, parseCodexSession, CODEX_SESSIONS_DIR } from './parsers/codex.js';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.js';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.js';
import { scanGeminiProjects, parseGeminiProject, GEMINI_TMP } from './parsers/gemini.js';
import { scanCopilotProjects, parseCopilotWorkspace } from './parsers/copilot.js';

const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
const CONFIG_PATH = path.join(CHRONICLE_DIR, 'config.json');
const DEBOUNCE_MS = 30 * 1000;       // a streaming JSONL isn't re-imported per line
const BACKSTOP_MS = 30 * 60 * 1000;  // catches missed fs events (macOS drops them across sleep)

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

export function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(CHRONICLE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function autoSyncEnabled() {
  return readConfig().autoSync !== false; // default ON
}

function state() {
  if (!globalThis.__chronicleAutoSync) {
    globalThis.__chronicleAutoSync = { watchers: [], timer: null, debounce: null, running: false, lastRun: null, lastResult: null };
  }
  return globalThis.__chronicleAutoSync;
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtime.getTime(); } catch { return null; }
}

// A Claude Code session's effective mtime includes its subagents dir.
function claudeMtime(file) {
  let m = mtimeOf(file) ?? 0;
  const sub = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  try {
    for (const f of fs.readdirSync(sub)) m = Math.max(m, mtimeOf(path.join(sub, f)) ?? 0);
  } catch {}
  return m || null;
}

// One incremental pass over every source. Imports sessions that are NEW in an
// already-imported project, or whose source file changed since their import.
export async function runIncrementalSync() {
  const st = state();
  if (st.running) return { ok: true, skipped: 'already running' };
  st.running = true;
  const started = Date.now();
  let imported = 0, checked = 0;
  try {
    const projectPaths = new Set(db.prepare('SELECT path FROM projects').all().map((p) => p.path));
    const bySession = new Map(db.prepare('SELECT id, file_path, imported_at FROM sessions').all().map((s) => [s.id, s]));
    const byFile = new Map(db.prepare('SELECT file_path, MAX(imported_at) AS at FROM sessions GROUP BY file_path').all().map((r) => [r.file_path, r.at]));
    const importedAtMs = (iso) => (iso ? new Date(iso + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z')).getTime() : 0);

    const importParsedList = (parsed) => {
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
      for (const s of item.sessions) {
        checked++;
        const prev = bySession.get(s.id);
        const m = claudeMtime(s.file);
        if (prev && m && m <= importedAtMs(prev.imported_at)) continue;
        importParsedList([await parseClaudeSession(s.file)]);
      }
    }
    for (const item of scanCodexProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath)) continue;
      for (const f of item.files) {
        checked++;
        const at = byFile.get(f);
        const m = mtimeOf(f);
        if (at && m && m <= importedAtMs(at)) continue;
        importParsedList([await parseCodexSession(f)]);
      }
    }
    // DB-backed / dir-backed sources: re-parse the whole store when its file is
    // newer than the last import from it.
    const staleStore = (storePath) => {
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
    for (const item of scanGeminiProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath) || !item.logDir) continue;
      checked++;
      if (staleStore(item.logDir)) importParsedList(await parseGeminiProject(item.logDir));
    }
    for (const item of scanCopilotProjects()) {
      if (!item.physicalPath || !projectPaths.has(item.physicalPath) || !item.logDir) continue;
      checked++;
      if (staleStore(item.logDir)) importParsedList(await parseCopilotWorkspace(item.logDir));
    }
    st.lastResult = { ok: true, imported, checked, ms: Date.now() - started };
  } catch (err) {
    st.lastResult = { ok: false, error: String(err.message || err) };
  } finally {
    st.lastRun = new Date().toISOString();
    st.running = false;
  }
  return st.lastResult;
}

export function autoSyncStatus() {
  const st = state();
  return { enabled: autoSyncEnabled(), running: st.running, lastRun: st.lastRun, lastResult: st.lastResult };
}

function scheduleDebounced() {
  const st = state();
  clearTimeout(st.debounce);
  st.debounce = setTimeout(() => { runIncrementalSync(); }, DEBOUNCE_MS);
}

export function startAutoSync() {
  const st = state();
  stopAutoSync();
  if (!autoSyncEnabled()) return;
  // fs-watch the known source dirs (recursive works on macOS/Windows; a dir that
  // doesn't exist or can't be watched is skipped — the timer is the backstop).
  const cursorDirs = scanCursorProjects().map((i) => i.logDir).filter(Boolean);
  const copilotDirs = scanCopilotProjects().map((i) => i.logDir).filter(Boolean);
  const dirs = [CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, path.dirname(OPENCODE_DB), GEMINI_TMP, ...cursorDirs, ...copilotDirs];
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

export function stopAutoSync() {
  const st = state();
  for (const w of st.watchers.splice(0)) { try { w.close(); } catch {} }
  clearInterval(st.timer); st.timer = null;
  clearTimeout(st.debounce); st.debounce = null;
}
