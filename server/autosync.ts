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
import { scanClaudeProjects, parseClaudeSession, claudeSessionMtimeMs, CLAUDE_PROJECTS_DIR } from './parsers/claudeCode.ts';
import { scanCodexProjects, parseCodexSession, CODEX_SESSIONS_DIR } from './parsers/codex.ts';
import { scanOpencodeProjects, parseOpencodeSessions, OPENCODE_DB } from './parsers/opencode.ts';
import { scanCursorProjects, parseCursorWorkspace } from './parsers/cursor.ts';
import type { ParseResult } from '../shared/types.ts';

export interface ChronicleConfig {
  autoSync?: boolean;
  autoSyncPaused?: boolean;
  // Spend-tab Claude Plan windows (CHI-324 2f / D7), default ON (opt-OUT). The
  // ONE outbound call in Chronicle: reads the user's own Claude quota from
  // api.anthropic.com (the token's own issuer, like Claude Code). Set false for a
  // fully offline instance. Codex windows are always local (never gated here).
  planWindows?: boolean;
  // Opt-in for /ask (CHI-351): the local claude-CLI-backed metric chat. Default
  // OFF. The `∴ Ask` sidebar entry + the runner are gated on this AND the claude
  // CLI being present AND a non-demo console (all enforced server-side).
  ask?: boolean;
  // Monthly spend budget in USD (CHI-366). The server-visible home for what used
  // to live only in the Spend tab's localStorage, so BOTH the Spend tab AND the
  // Spend tab read the SAME number wherever it is shown.
  // null / absent = no budget set. Local app pref, written like the toggles
  // above via /settings.
  monthlyBudget?: number | null;
  // Local-only view log (CHI-325 3a / D7), default ON (opt-OUT). Records which
  // surfaces get used, actor-tagged, in chronicle.db. Nothing about it is
  // outbound — the no-telemetry floor is untouched — but it records the
  // operator's own behavior, so it gets a visible switch and a Clear button in
  // Settings rather than being invisible machinery. See server/viewlog.ts.
  viewLog?: boolean;
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
  // Timestamp (ms) of the first fs-watch event in the current pending burst,
  // or null when no sync is currently debounced. Lets scheduleDebounced cap
  // how long continuous churn can keep pushing the run out — see nextDelay.
  firstPendingAt: number | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleAutoSync: AutoSyncState | undefined;
}

const CHRONICLE_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
const CONFIG_PATH = path.join(CHRONICLE_DIR, 'config.json');
const DEBOUNCE_MS = 30 * 1000;       // a streaming JSONL isn't re-imported per line
const MAXWAIT_MS = 2 * 60 * 1000;    // continuous churn can't starve a sync past this
const BACKSTOP_MS = 30 * 60 * 1000;  // catches missed fs events (macOS drops them across sleep)

// Pure scheduling decision, extracted so it can be unit-tested without fake
// timers: how long should the NEXT debounce wait be, given the current time
// and when the pending burst started (null = no burst pending yet, i.e. this
// event starts one)? Every fs-watch event resets a plain setTimeout(DEBOUNCE_MS)
// to the same DEBOUNCE_MS, so under continuous file activity the timer never
// fires and a sync is starved until the 30-min backstop. Clamping the delay to
// what's left of MAXWAIT_MS (measured from the START of the burst, which
// doesn't move) guarantees the first pending event still gets synced within
// MAXWAIT_MS regardless of how many more events arrive after it.
export function nextDelay(nowMs: number, firstPendingAtMs: number | null): number {
  const first = firstPendingAtMs === null ? nowMs : firstPendingAtMs;
  return Math.min(DEBOUNCE_MS, Math.max(0, first + MAXWAIT_MS - nowMs));
}

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
    globalThis.__chronicleAutoSync = { watchers: [], timer: null, debounce: null, running: false, lastRun: null, lastResult: null, firstPendingAt: null };
  }
  return globalThis.__chronicleAutoSync;
}

function mtimeOf(file: string): number | null {
  try { return fs.statSync(file).mtime.getTime(); } catch { return null; }
}

// A Claude Code session's effective mtime includes its subagents tree
// (direct + workflows/*, recursively) — see claudeSessionMtimeMs.
const claudeMtime = claudeSessionMtimeMs;

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
    st.firstPendingAt = null; // this run (whatever triggered it) has caught up any pending burst
  }
  return st.lastResult as SyncResult;
}

export function autoSyncStatus(): { enabled: boolean; running: boolean; lastRun: string | null; lastResult: SyncResult | null; firstPendingAt: number | null } {
  const st = state();
  return { enabled: autoSyncEnabled(), running: st.running, lastRun: st.lastRun, lastResult: st.lastResult, firstPendingAt: st.firstPendingAt };
}

export function scheduleDebounced(): void {
  const st = state();
  const now = Date.now();
  if (st.firstPendingAt === null) st.firstPendingAt = now; // this event starts a new burst
  clearTimeout(st.debounce ?? undefined);
  st.debounce = setTimeout(() => { runIncrementalSync(); }, nextDelay(now, st.firstPendingAt));
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
