import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { agentActiveMs, engagedMs } from '../shared/durations.ts';
import { isMinorSession } from './noiseGate.ts';
import { isErrorHead } from '../shared/errors.ts';
import { invalidateCache } from './cache.ts';
import type { Event, SessionInput, Project } from '../shared/types.ts';
import { parseUsage, totalTokens, type UsageByModel } from '../shared/usage.ts';
import { dataDir } from './config.ts';

// Row shapes live in shared/rows.ts (#307), so the client reads the same
// `sessions`/`messages` contract the server writes. Every server query that
// selects these columns imports them from there directly; this module only
// needs the projects row for its own upsert.
import type { ProjectRow } from '../shared/rows.ts';

import { applySchema } from './schema.ts';

// Nothing in this module runs on import (issue #275, audit F13): opening the
// database, applying the schema and running the backfills is what
// `openDatabase(dir)` is for, and every other module reads the open handle
// through `getDb()`. That is what lets a test build an app against a temp
// database in one line — `createApp(openDatabase(dir))` — instead of mounting
// routers one at a time to dodge an import side effect.
//
// The open handles live on globalThis, the same idiom as server/cache.ts and
// server/live.ts: a Vite SSR module reload re-evaluates this file, and a second
// DatabaseSync over a file the first one still holds is a lock fight, not a
// fresh start.
interface DbState {
  /** The handle getDb() hands out: the last database opened or selected. */
  active: DatabaseSync | null;
  /** Open handles by database file, so opening the same folder twice is one handle. */
  open: Map<string, DatabaseSync>;
  /** Per-handle facts the callers need: which folder it lives in, whether FTS5 took. */
  meta: WeakMap<DatabaseSync, { dir: string; fts: boolean }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleDb: DbState | undefined;
}

const state: DbState = (globalThis.__chronicleDb ??= { active: null, open: new Map(), meta: new WeakMap() });

/**
 * Open the Chronicle database in `dir`, apply the schema, run the backfills,
 * and make it the handle every other module reads. Idempotent per folder: the
 * second call for the same folder hands back the first call's handle.
 *
 * `dir` defaults to the folder this process was started against
 * (server/config.ts); a test passes its own temp folder.
 */
export function openDatabase(dir: string = dataDir): DatabaseSync {
  const file = path.join(dir, 'chronicle.db');
  const already = state.open.get(file);
  if (already) { state.active = already; return already; }
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  // WAL, and it stays on. The SQLite-backed parsers are what makes a write long:
  // Cursor and OpenCode keep a whole workspace in ONE database, so a parse is a
  // single pass that hands back every session at once and autosync writes the lot
  // in one run. This handle is synchronous and the server is single-threaded, so
  // that run blocks nothing in-process; the contention WAL exists for is across
  // processes. Ask holds a read-only handle on this same file from a `claude -p`
  // spawn, and a second Chronicle on the same data folder is the SQLITE_BUSY case
  // the result_count backfill below already guards. Under rollback-journal the
  // whole import holds an exclusive lock and those readers fail; WAL lets them
  // read the last committed snapshot while it runs.
  // Fail soft: a filesystem that cannot do WAL (some network mounts) keeps the
  // old journal mode rather than losing the database.
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* keep the default journal mode */ }
  const fts = applySchema(db);
  state.open.set(file, db);
  state.meta.set(db, { dir, fts });
  // Active BEFORE the backfills: they read the handle back through getDb()
  // (snapshotDb does), so the database being filled has to be the current one.
  state.active = db;
  runBackfills(db);
  return db;
}

/** Read and write `db` from here on — what createApp(db) calls so the routes it
 *  mounts serve the database they were handed. */
export function useDatabase(db: DatabaseSync): void {
  state.active = db;
}

/** The open database. Throws rather than opening one: an implicit open is the
 *  side effect this module exists to have removed. */
export function getDb(): DatabaseSync {
  if (!state.active) {
    throw new Error('Chronicle: no database is open. Call openDatabase(dir) before using the server modules.');
  }
  return state.active;
}

/** Whether the full-text index took on this database; search falls back to LIKE
 *  when it did not (server/routes/search.ts). */
export function ftsAvailable(db: DatabaseSync = getDb()): boolean {
  return state.meta.get(db)?.fts ?? false;
}

/** The data folder a handle was opened against. */
function dirOf(db: DatabaseSync): string {
  return state.meta.get(db)?.dir ?? dataDir;
}

/** The one-time data repairs an older database needs. Each one fails soft, for
 *  the reason spelled out above it: a deferred backfill costs accuracy until the
 *  next boot retries it, a thrown one would cost the operator their app. */
function runBackfills(db: DatabaseSync): void {
  // ~0.5s warm on the maintainer's 108k-row DB; runs once per database, ever.
  // Failure (e.g. SQLITE_BUSY from a stale second Chronicle process holding a
  // write lock at this exact first-boot-after-upgrade moment) must NOT kill
  // startup: the rows just stay NULL — COALESCE(...,0) in the readers degrades
  // to undercounted errors until the next boot retries the backfill.
  try {
    const missing = (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE result_count IS NULL').get() as unknown as { c: number }).c;
    if (missing > 0) {
      const heads = db.prepare(`SELECT session_id, substr(text, 1, 200) AS head FROM messages
                                WHERE kind = 'tool_result' AND text IS NOT NULL`).all() as unknown as { session_id: string; head: string }[];
      const agg = new Map<string, { rc: number; ec: number }>();
      for (const r of heads) {
        let a = agg.get(r.session_id);
        if (!a) { a = { rc: 0, ec: 0 }; agg.set(r.session_id, a); }
        a.rc++;
        if (isErrorHead(r.head)) a.ec++;
      }
      db.exec('BEGIN');
      try {
        db.exec('UPDATE sessions SET result_count = 0, error_count = 0 WHERE result_count IS NULL');
        const up = db.prepare('UPDATE sessions SET result_count = ?, error_count = ? WHERE id = ?');
        for (const [id, a] of agg) up.run(a.rc, a.ec, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } catch (err) {
    console.warn('[chronicle] error-count backfill deferred (will retry next start):', (err as Error).message);
  }

  // Failure must not kill startup — same rule as the error-count backfill above.
  // A second Chronicle process holding a write lock (SQLITE_BUSY) is the likely
  // cause; the marker is only written inside the committed transaction, so a
  // failed run leaves nothing half-applied and retries on the next boot.
  try {
    collapseRepeatedUsageBackfill(db);
  } catch (err) {
    console.warn('[chronicle] backfill deferred (will retry next start):', (err as Error).message);
  }
}

// ---- one-time backfill ------------------------------------------
//
// Every session imported before the parser fix billed each API call once per
// transcript line it was split across (2.20-2.44x measured against transcript
// truth; 1.67-2.04x against Anthropic's own reported usage). Two lanes:
//
//   Lane 1 (exact)  Sessions whose transcript is still on disk: NULL their
//                   imported_at so the next autosync pass re-parses them
//                   through the fixed parser (autosync.ts skips on
//                   `mtime <= imported_at`, and importedAtMs(null) === 0).
//                   replaceSession then stamps usage_source='exact'.
//   Lane 2 (rederived)  Everything else — Claude Code prunes ~/.claude/projects,
//                   so for most history the DB is the only surviving record.
//                   Collapse runs of identical per-message usage signatures and
//                   rebuild sessions.usage from the survivors. Measured +1.9%
//                   against transcript truth on the sessions where both exist,
//                   versus +120% left alone.
//
// Lane 2 runs over Lane 1's sessions too, so the number is right even if
// auto-sync never runs; the re-import later upgrades them to 'exact'.
// The persisted migration name. This exact string sits in `chronicle_migrations`
// on every install that has already run the backfill, so it is a SCHEMA VALUE,
// not prose: renaming it would re-run the whole backfill on live databases. It
// is the one place the retired tracker's vocabulary is allowed to survive, and
// test/repo-shape.test.mjs exempts this literal by value, not the file.
// The literal is a schema value: it is written into chronicle_migrations on
// every install that has run this backfill, so renaming it would re-run the
// backfill on live databases. Its wording is frozen history.
const COLLAPSE_REPEATED_USAGE = 'chi-286-collapse-replayed-usage';

interface UsageRow {
  id: number;
  session_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_w5m_tokens: number;
  cache_w1h_tokens: number;
}

function collapseRepeatedUsageBackfill(db: DatabaseSync): void {
  const done = db.prepare('SELECT 1 AS x FROM chronicle_migrations WHERE name = ?').get(COLLAPSE_REPEATED_USAGE);
  if (done) return;
  const targets = db.prepare(`SELECT id, file_path, usage FROM sessions
                              WHERE source = 'claude-code' AND usage IS NOT NULL`)
    .all() as unknown as { id: string; file_path: string; usage: string }[];
  if (targets.length) {
    snapshotDb(true); // unconditional: this rewrites history in place
    // ONE ordered scan of the usage-bearing rows, not a query per session.
    const rows = db.prepare(`SELECT m.id, m.session_id, m.model,
             COALESCE(m.input_tokens,0) AS input_tokens, COALESCE(m.output_tokens,0) AS output_tokens,
             COALESCE(m.cache_read_tokens,0) AS cache_read_tokens,
             COALESCE(m.cache_w5m_tokens,0) AS cache_w5m_tokens, COALESCE(m.cache_w1h_tokens,0) AS cache_w1h_tokens
        FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.source = 'claude-code' AND m.input_tokens IS NOT NULL
       ORDER BY m.session_id, m.seq`).all() as unknown as UsageRow[];
    const rebuilt = new Map<string, UsageByModel>();
    const drop: number[] = [];
    let prevSession = '';
    let prevSig = '';
    for (const r of rows) {
      const model = r.model || 'unknown';
      const total = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_w5m_tokens + r.cache_w1h_tokens;
      const sig = `${model}|${r.input_tokens}|${r.output_tokens}|${r.cache_read_tokens}|${r.cache_w5m_tokens}|${r.cache_w1h_tokens}`;
      if (r.session_id !== prevSession) { prevSession = r.session_id; prevSig = ''; }
      // A repeated usage row repeats the previous row's cells exactly. `total > 0` is an
      // all-zero guard: the only false positive found across every
      // transcript on disk was a pair of adjacent all-zero `<synthetic>` rows,
      // and collapsing a genuinely-zero row would be a (harmless) guess.
      if (total > 0 && sig === prevSig) { drop.push(r.id); continue; }
      prevSig = sig;
      let byModel = rebuilt.get(r.session_id);
      if (!byModel) { byModel = {}; rebuilt.set(r.session_id, byModel); }
      const agg = byModel[model] || (byModel[model] = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
      agg.input += r.input_tokens;
      agg.output += r.output_tokens;
      agg.cacheRead += r.cache_read_tokens;
      agg.cacheWrite5m += r.cache_w5m_tokens;
      agg.cacheWrite1h += r.cache_w1h_tokens;
    }
    db.exec('BEGIN');
    try {
      const setUsage = db.prepare('UPDATE sessions SET usage = ?, usage_source = ? WHERE id = ?');
      const clearRow = db.prepare(`UPDATE messages SET input_tokens = NULL, output_tokens = NULL,
                                   cache_read_tokens = NULL, cache_w5m_tokens = NULL, cache_w1h_tokens = NULL
                                   WHERE id = ?`);
      let rederived = 0, unverified = 0;
      for (const s of targets) {
        const next = rebuilt.get(s.id);
        // No per-message token rows at all (an import predating those columns):
        // there is nothing to re-derive from, so leave the inflated value and
        // SAY SO rather than silently zeroing real spend.
        if (!next || totalTokens(next) === 0) { setUsage.run(s.usage, 'unverified', s.id); unverified++; continue; }
        const prevTotal = totalTokens(parseUsage(s.usage));
        // Never rewrite UPWARD. The message lane is a subset of what the old
        // accumulator summed, so a larger result means an assumption broke.
        if (prevTotal > 0 && totalTokens(next) > prevTotal) { setUsage.run(s.usage, 'unverified', s.id); unverified++; continue; }
        setUsage.run(JSON.stringify(next), 'rederived', s.id);
        rederived++;
      }
      // Duplicate rows lose their token columns so summing `messages`
      // stops double-counting for history too. NULL (not 0) keeps "dropped"
      // distinguishable from "genuinely zero"; every reader COALESCEs, and
      // messages_fts indexes only text/tool_input, so no index maintenance.
      for (const id of drop) clearRow.run(id);
      // Lane 1 last, inside the same transaction as the marker.
      const relive = db.prepare('UPDATE sessions SET imported_at = NULL WHERE id = ?');
      let reimport = 0;
      for (const s of targets) if (fs.existsSync(s.file_path)) { relive.run(s.id); reimport++; }
      db.prepare('INSERT INTO chronicle_migrations (name) VALUES (?)').run(COLLAPSE_REPEATED_USAGE);
      db.exec('COMMIT');
      console.log(`[chronicle] backfill: ${rederived} sessions re-derived, ${unverified} unverified, ` +
                  `${drop.length} duplicate token rows cleared, ${reimport} queued for exact re-import`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } else {
    db.prepare('INSERT INTO chronicle_migrations (name) VALUES (?)').run(COLLAPSE_REPEATED_USAGE);
  }
}

// Failure must not kill startup — same rule as the error-count backfill above.
// A second Chronicle process holding a write lock (SQLITE_BUSY) is the likely
// cause; the marker is only written inside the committed transaction, so a
// removal, via routes/_shared.ts's backupDbBeforeDelete) and before the usage
// backfill rewrites historical usage. Throttled to at most one snapshot per
// hour so a multi-select Remove loop makes ONE backup, not N; `force` overrides
// that for a one-shot migration, which must always be recoverable. Keeps the
// two newest. Restore = stop the app and copy the snapshot back over
// chronicle.db (delete any -wal/-shm sidecars alongside it first).
export function snapshotDb(force = false): string | null {
  try {
    const db = getDb();
    const dir = path.join(dirOf(db), 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.startsWith('chronicle-')).sort();
    const newest = existing[existing.length - 1];
    if (!force && newest && Date.now() - fs.statSync(path.join(dir, newest)).mtime.getTime() < 60 * 60 * 1000) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `chronicle-${stamp}.db`);
    db.exec('BEGIN'); db.exec('COMMIT'); // barrier: no open write txn while copying
    // WAL means committed pages can still be sitting in chronicle.db-wal, and
    // the copy below takes the main file only (restoring deletes the sidecars).
    // Checkpoint first or a snapshot silently omits everything since the last
    // auto-checkpoint. Best-effort: a busy checkpoint leaves the copy exactly as
    // stale as it would have been, which beats losing the snapshot entirely.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* copy what is on disk */ }
    fs.copyFileSync(path.join(dirOf(db), 'chronicle.db'), dest);
    // Keep the newest two snapshots total (the one just written + one prior).
    for (const f of existing.slice(0, Math.max(0, existing.length - 1))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    return dest;
  } catch {
    return null;
  }
}

// ---- Tombstones (Phase 5 PR 5a: delete + undo) ----

export function isTombstoned(source: string, sessionId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM session_tombstones WHERE source = ? AND session_id = ?').get(source, sessionId);
}

export function tombstoneSession(source: string, sessionId: string): void {
  getDb().prepare(`INSERT INTO session_tombstones (source, session_id, deleted_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(source, session_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(source, sessionId);
}

// Undo: forget the tombstone. The source log is untouched, so the caller just
// needs to re-trigger an import/sync afterward to bring the session back.
export function removeTombstone(source: string, sessionId: string): void {
  getDb().prepare('DELETE FROM session_tombstones WHERE source = ? AND session_id = ?').run(source, sessionId);
}

// Whole-project delete: tombstone every session that belonged to it, so a
// paused-then-resumed auto-sync doesn't resurrect them.
export function tombstoneSessionsForProject(projectId: number | string): void {
  const rows = getDb().prepare('SELECT id, source FROM sessions WHERE project_id = ?').all(projectId) as unknown as { id: string; source: string }[];
  for (const r of rows) tombstoneSession(r.source, r.id);
}

export function upsertProject(physicalPath: string): ProjectRow {
  const name = path.basename(physicalPath) || physicalPath;
  getDb().prepare('INSERT INTO projects (path, name) VALUES (?, ?) ON CONFLICT(path) DO NOTHING').run(physicalPath, name);
  return getDb().prepare('SELECT * FROM projects WHERE path = ?').get(physicalPath) as unknown as ProjectRow;
}

export function replaceSession(session: SessionInput, events: Event[]): void {
  // Tombstoned sessions must never be resurrected by a re-scan of the same
  // source file — check BEFORE touching the DB, from every import path
  // (manual import, per-project/per-session sync, auto-sync).
  if (isTombstoned(session.source, session.id)) return;
  const db = getDb();
  db.exec('BEGIN');
  try {
    // Preserve a user-set display name, and a promoted-out-of-minor state,
    // across re-imports (delete + reinsert).
    const prev = db.prepare('SELECT name, minor FROM sessions WHERE id = ?').get(session.id) as { name: string | null; minor: number | null } | undefined;
    if (ftsAvailable(db)) {
      db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text, tool_input)
                  SELECT 'delete', id, COALESCE(text,''), COALESCE(tool_input,'')
                  FROM messages WHERE session_id = ?`).run(session.id);
    }
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    const sidechainCount = events.reduce((n, e) => n + (e.is_sidechain ? 1 : 0), 0);
    const activeMs = agentActiveMs(events);
    // Precomputed error-heuristic aggregates — see the migration comment above.
    let resultCount = 0, errorCount = 0;
    // `!= null` (not truthiness): empty-string results count toward
    // result_count, matching the backfill's `text IS NOT NULL` and the old
    // per-request query — else re-import shrinks the error-rate denominator.
    for (const e of events) {
      if (e.kind !== 'tool_result' || e.text == null) continue;
      resultCount++;
      if (isErrorHead(e.text)) errorCount++;
    }
    // Once a session is promoted out of (or was never in) the minor bucket,
    // that stays sticky across re-imports — otherwise a re-sync would silently
    // undo the user's "promote" action every time.
    const minor = prev && prev.minor === 0 ? 0 : (isMinorSession(activeMs, events.length) ? 1 : 0);
    // Only claude-code carries a per-API-call id, so only it can claim 'exact'.
    // Codex attaches tokens from `token_count` events with no call id at all;
    // cursor/opencode carry no token data. Stamping 'exact' unconditionally
    // here would make the column useless as an audit signal.
    const usageSource = session.source === 'claude-code' ? 'exact' : null;
    db.prepare(`INSERT INTO sessions (id, project_id, source, file_path, started_at, ended_at, message_count, first_prompt, context_tokens, name, summary, usage,
                                      sidechain_count, agent_active_ms, engaged_ms, imported_at, minor, result_count, error_count, usage_source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.project_id, session.source, session.file_path,
           session.started_at ?? null, session.ended_at ?? null, events.length, session.first_prompt ?? null,
           session.context_tokens ?? null, session.name ?? prev?.name ?? null,
           session.summary ?? null, session.usage ?? null,
           sidechainCount, activeMs, engagedMs(events), new Date().toISOString(), minor, resultCount, errorCount, usageSource);
    const ins = db.prepare(`INSERT INTO messages (session_id, seq, uuid, ts, kind, text, tool_name, tool_input, tool_use_id, model,
                                                  is_sidechain, agent_type, workflow_id, agent_id, agent_desc, skill, message_id, request_id, input_tokens, output_tokens, cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    events.forEach((e, i) => ins.run(session.id, i, e.uuid ?? null, e.ts ?? null, e.kind,
      e.text ?? null, e.tool_name ?? null, e.tool_input ?? null, e.tool_use_id ?? null, e.model ?? null,
      e.is_sidechain ? 1 : 0, e.agent_type ?? null, e.workflow_id ?? null, e.agent_id ?? null, e.agent_desc ?? null, e.skill ?? null,
      e.message_id ?? null, e.request_id ?? null,
      e.input_tokens ?? null, e.output_tokens ?? null, e.cache_read_tokens ?? null,
      e.cache_w5m_tokens ?? null, e.cache_w1h_tokens ?? null));
    if (ftsAvailable(db)) {
      db.prepare(`INSERT INTO messages_fts(rowid, text, tool_input)
                  SELECT id, COALESCE(text,''), COALESCE(tool_input,'')
                  FROM messages WHERE session_id = ?`).run(session.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Sessions/messages changed — every cached analytics result (insights,
  // explore, content, per-project analytics) may now be stale.
  invalidateCache();
}
