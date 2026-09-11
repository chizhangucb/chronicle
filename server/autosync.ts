// Invisible auto-sync: keep the DB fresh without manual syncs.
// Triggers: server start, a 30-min backstop timer, and a debounced (~30 s)
// fs-watch on the known source log dirs. Incremental:
// only sessions whose source file mtime is newer than their last import are
// re-parsed; `replaceSession` is idempotent, so partial in-progress imports are
// simply superseded by the next pass. State lives on globalThis so Vite SSR
// module reloads don't orphan watchers/timers.
import fs from 'node:fs';
import path from 'node:path';
import { db, upsertProject, replaceSession } from './db.ts';
import { SOURCES } from './parsers/registry.ts';
import { importableFiles } from './parsers/source.ts';
import type { Source } from './parsers/source.ts';
import { readConfig } from './config.ts';
import type { ParseResult } from '../shared/types.ts';
// The status shape the Settings surface reads (shared/results.ts, #307).
import type { AutosyncStatus } from '../shared/results.ts';

interface SyncResultOk {
  ok: true;
  imported: number;
  checked: number;
  ms: number;
}
interface SyncResultSkipped {
  ok: true;
  skipped: string;
}
interface SyncResultError {
  ok: false;
  error: string;
}
type SyncResult = SyncResultOk | SyncResultSkipped | SyncResultError;

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
// Exported for test/autosync-maxwait.test.mjs: nextDelay is the clamp,
// asserted without waiting on wall-clock timers; scheduleDebounced below is
// its production caller.
export function nextDelay(nowMs: number, firstPendingAtMs: number | null): number {
  const first = firstPendingAtMs === null ? nowMs : firstPendingAtMs;
  return Math.min(DEBOUNCE_MS, Math.max(0, first + MAXWAIT_MS - nowMs));
}

function autoSyncEnabled(): boolean {
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

// The directory to watch for a path that names a source's records: the path
// itself when it is a directory, its parent when it is a store file (a SQLite
// write can land in the `-wal` sibling without touching the file itself).
// A path that isn't there yet is read by its spelling: a store file (it has an
// extension) is watched through the dir it will appear in, a log root is left
// as itself — watching ITS parent would mean recursively watching an unrelated
// tree (`~/.claude`, `~/.codex`, the whole Cursor app dir), and the backstop
// timer already covers a root that appears later.
function watchDirOf(p: string): string {
  try { return fs.statSync(p).isDirectory() ? p : path.dirname(p); } catch { /* not there — go by the spelling */ }
  return path.extname(p) ? path.dirname(p) : p;
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

    // One pass per source, through the `Source` interface: nothing here knows
    // which coding tool it is looking at.
    //
    // A scan that lists files (one transcript per session) gets the cheap
    // per-file mtime pre-filter and a parse scoped to the stale file; a scan
    // that lists none (a shared SQLite store) is re-parsed whole when the store
    // is newer than the last import out of it. `Source.mtime` is what makes
    // both cheap: it folds in whatever else counts as a write for that source
    // (Claude Code's subagents tree, a store's `-wal` sidecar).
    const staleStore = (source: Source, storePath: string): boolean => {
      const at = [...byFile.entries()].filter(([f]) => f === storePath || f.startsWith(storePath)).map(([, v]) => v).sort().pop();
      const m = source.mtime(storePath);
      return !at || !m || m > importedAtMs(at);
    };
    for (const source of SOURCES) {
      for (const item of source.scan()) {
        if (!item.physicalPath || !projectPaths.has(item.physicalPath)) continue;
        const files = importableFiles(item);
        if (!files.length) {
          checked++;
          if (staleStore(source, item.logDir)) importParsedList(await source.parse(item));
          continue;
        }
        for (const file of files) {
          checked++;
          const at = byFile.get(file);
          const m = source.mtime(file);
          if (at && m && m <= importedAtMs(at)) continue;
          importParsedList(await source.parse({ ...item, files: [file] }));
        }
      }
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

export function autoSyncStatus(): AutosyncStatus {
  const st = state();
  return { enabled: autoSyncEnabled(), running: st.running, lastRun: st.lastRun, lastResult: st.lastResult, firstPendingAt: st.firstPendingAt };
}

// Exported for test/autosync-maxwait.test.mjs: scheduleDebounced is the
// debounce state machine, driven event by event instead of through a real
// fs watcher.
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
  // fs-watch every dir a source's records can be written to: its default root,
  // plus any scanned project that sits outside it (Cursor files a project's
  // Agent transcripts under ~/.cursor/projects, nowhere near its user dir).
  // A dir already covered by a watched ancestor is dropped — the watch is
  // recursive, so one watcher over the root is the whole subtree (recursive
  // works on macOS/Windows; a dir that doesn't exist or can't be watched is
  // skipped — the timer is the backstop).
  const candidates = new Set(SOURCES.flatMap((s) => [
    watchDirOf(s.defaultRoot()),
    ...s.scan().map((item) => watchDirOf(item.logDir)),
  ]));
  const dirs = [...candidates].filter((d) => ![...candidates].some((o) => o !== d && d.startsWith(o + path.sep)));
  for (const d of dirs) {
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
