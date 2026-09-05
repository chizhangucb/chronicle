import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { agentActiveMs, engagedMs } from './durations.ts';
import { isMinorSession } from './noiseGate.ts';
import { isErrorHead } from './errors.ts';
import { invalidateCache } from './cache.ts';
import type { Event, SessionInput, Project, ModelUsage } from '../shared/types.ts';
import { resolveDataDir } from './dataDir.ts';

export type ProjectRow = Project;

// Full `sessions` row shape, as read back out of the DB (all columns, incl.
// the ones added by the idempotent ALTER TABLE migrations below).
export interface SessionRow {
  id: string;
  project_id: number;
  source: string;
  file_path: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  context_tokens: number | null;
  name: string | null;
  summary: string | null;
  usage: string | null;
  sidechain_count: number;
  imported_at: string | null;
  agent_active_ms: number | null;
  engaged_ms: number | null;
  minor: number;
  result_count: number | null;
  error_count: number | null;
  // Provenance of `usage`. 'exact' = parsed from a transcript by a
  // parser that collapses replayed lines on (message_id, request_id).
  // 'rederived' = the source transcript is gone, so the migration
  // rebuilt it structurally from the stored per-message token columns.
  // 'unverified' = neither was possible; the pre-fix (inflated) value stands.
  // NULL = imported before the column existed.
  usage_source: string | null;
}

// Full `messages` row shape.
export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  uuid: string | null;
  ts: string | null;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  model: string | null;
  is_sidechain: number;
  agent_type: string | null;
  workflow_id: string | null;
  agent_id: string | null;
  agent_desc: string | null;
  skill: string | null;
  // Anthropic's per-API-call identity. `uuid` above is per transcript
  // LINE; one API call is split across several lines, so this pair is the only
  // stable per-CALL key.
  message_id: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_w5m_tokens: number | null;
  cache_w1h_tokens: number | null;
}

export const dataDir = resolveDataDir();
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));

// WAL. Until the view log there was exactly one writer, at import
// time, so rollback-journal's exclusive per-write lock never contended. The
// view log writes on every navigation against this same synchronous handle
// while it is also serving heavy analytics reads, which is precisely the shape
// rollback-journal serializes worst (and the SQLITE_BUSY note on the
// result_count backfill below is the existing evidence). WAL lets the readers
// proceed against the last committed snapshot while a write is in flight.
// Fail soft: a filesystem that cannot do WAL (some network mounts) keeps the
// old journal mode rather than losing the database.
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* keep the default journal mode */ }

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER DEFAULT 0,
  first_prompt TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  uuid TEXT,
  ts TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  tool_name TEXT,
  tool_input TEXT,
  tool_use_id TEXT,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
-- Supports the tool_result<->tool_use pairing self-join used by explore.ts
-- (errRows) and content.ts (toolChars): ON u.session_id=r.session_id AND
-- u.tool_use_id=r.tool_use_id AND u.kind='tool_use'. Without this, SQLite
-- can only SEARCH the tool_use side by session_id (idx_messages_session),
-- then linear-scan every message in the session to find the matching
-- tool_use_id -- quadratic within large sessions. Measured on the
-- maintainer's ~395MB/101k-row real DB: this index alone cut /api/explore
-- and /api/content from ~24-37s to ~1-1.5s (see task-perf-report.md for the
-- full before/after table).
CREATE INDEX IF NOT EXISTS idx_messages_tooluse ON messages(session_id, tool_use_id);
-- COVERING index for the Insights/project-analytics aggregates (toolDist,
-- kindDist, modelDist, dailyActivity, hourlyActivity). Those queries group
-- over kind/tool_name/model/ts joined to sessions -- without this, SQLite
-- picks SCAN over the messages table itself, and messages rows are FAT
-- (text/tool_input blobs), so every /api/insights range click re-read the
-- whole ~400MB table: 0.1-3.6s per query warm, multi-second cold. With it,
-- the engines drive from sessions (small) and read ONLY slim index entries:
-- measured 6-65ms per query on the maintainer's 414MB/108k-row real DB.
-- The queries force this shape with CROSS JOIN (sessions outer).
CREATE INDEX IF NOT EXISTS idx_messages_agg ON messages(session_id, kind, ts, tool_name, model);
-- Tombstones: sessions deliberately removed from Chronicle (single delete or
-- whole-project delete). Keyed on (source, session id) since ids are only
-- unique within a source. Import/autosync paths (replaceSession) consult this
-- BEFORE inserting so a tombstoned session is never resurrected by a
-- subsequent scan of the same source file. Deleting undoes = removing the row.
CREATE TABLE IF NOT EXISTS session_tombstones (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deleted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, session_id)
);
-- Local-only view log (3a, decision D5-D8). Which surfaces actually get
-- used, actor-tagged, so a boundary question like the is answered with
-- data instead of file mtimes. NEVER leaves the machine: no route reads it out
-- except the operator's own Settings block, and there is no outbound path.
--
-- The route column is a PATTERN ('/session/:id'), never an instance.
-- The log answers "which surfaces earn their space", not "which session did I
-- read". Pattern-only keeps it from becoming a second copy of the history.
--
-- The four actor columns are stored UNCOLLAPSED on purpose. No detector
-- catches an agent driving a real browser profile today; when a better
-- fingerprint is found, the retained rows can be re-tagged. Collapsing to one
-- verdict at write time would repeat the error permanently. Readers
-- collapse via collapseActor() in server/viewlog.ts.
CREATE TABLE IF NOT EXISTS view_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  event TEXT NOT NULL,          -- 'visit' | 'tab' | 'action'
  detail TEXT,                  -- tab name / action id, null for a bare visit
  dwell_ms INTEGER,             -- capped at DWELL_CEILING_MS; null when unclosed
  actor_client TEXT,            -- 'human' | 'agent' (browser's own verdict)
  actor_server TEXT,            -- 'human' | 'agent' (UA verdict on this POST)
  ua TEXT,                      -- raw, for later re-derivation
  gesture INTEGER               -- 1 = a trusted input event preceded this nav
);
CREATE INDEX IF NOT EXISTS idx_view_log_ts ON view_log(ts);
`);

// Idempotent migrations
try { db.exec('ALTER TABLE sessions ADD COLUMN context_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN name TEXT'); } catch {}       // user-set display name (survives re-import)
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch {}    // tool-provided summary (parsed each import)
try { db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT'); } catch {}      // per-model token totals as JSON
// v0.2 substrate (design doc §1.1/§1.3)
try { db.exec('ALTER TABLE sessions ADD COLUMN sidechain_count INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN imported_at TEXT'); } catch {} // last import time (incremental auto-sync)
try { db.exec('ALTER TABLE sessions ADD COLUMN agent_active_ms INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN engaged_ms INTEGER'); } catch {}
// Noise gate (Phase 5 PR 5a): sessions under the configured threshold are
// gated out of the main lists into a global "minor sessions" bucket at
// import time (see noiseGate.ts + replaceSession below). 0/1, default 0.
try { db.exec('ALTER TABLE sessions ADD COLUMN minor INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN is_sidechain INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN agent_type TEXT'); } catch {}
// `wf_*` folder name for a subagent transcript nested under
// subagents/workflows/wf_*/ (null for a direct subagent or non-sidechain row).
try { db.exec('ALTER TABLE messages ADD COLUMN workflow_id TEXT'); } catch {}
// Per-RUN id (distinct from agent_type, which is per-KIND) — see shared/types.ts Event.agent_id.
try { db.exec('ALTER TABLE messages ADD COLUMN agent_id TEXT'); } catch {}
// Per-RUN description, read from the run's agent-<hex>.meta.json sidecar
// `description` field (was parsed but discarded — see shared/types.ts Event.agent_desc).
// Existing imports backfill it on their next sync; no forced re-import.
try { db.exec('ALTER TABLE messages ADD COLUMN agent_desc TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN skill TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_w5m_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_w1h_tokens INTEGER'); } catch {}
// Precomputed error-heuristic aggregates (perf fix): result_count = tool_result
// messages with text, error_count = the subset whose head matches ERROR_RE.
// Computed once at import in replaceSession (same pattern as durations), so
// insights/project analytics read 3-figure session rows instead of regexing
// tens of thousands of tool_result heads per request (was 0.8-17s per click).
try { db.exec('ALTER TABLE sessions ADD COLUMN result_count INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN error_count INTEGER'); } catch {}
// Call key: Anthropic's per-API-call identity. Claude Code splits ONE API
// response across several transcript lines (empty thinking / text / tool_use),
// each repeating the full `message.usage`; summing per line billed a call two
// or three times. `uuid` is per-LINE, so it can't collapse them — this pair
// can. Persisted on every assistant row (usage-bearing or not) so any later
// pass can apply the same dedup.
try { db.exec('ALTER TABLE messages ADD COLUMN message_id TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN request_id TEXT'); } catch {}
// Provenance of sessions.usage — see SessionRow.usage_source above.
try { db.exec('ALTER TABLE sessions ADD COLUMN usage_source TEXT'); } catch {}
// Explicit one-shot migration ledger. A data-shaped gate (e.g. "usage_source IS
// NULL") is NOT safe here: replaceSession enumerates its INSERT columns, so any
// re-import resets that column and a data-gated migration would re-run on the
// next boot, forever.
db.exec(`CREATE TABLE IF NOT EXISTS chronicle_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
)`);

// One-time backfill for sessions imported before the columns existed (NULL).
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
const CHI286 = 'chi-286-collapse-replayed-usage';

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

function chi286Backfill(): void {
  const done = db.prepare('SELECT 1 AS x FROM chronicle_migrations WHERE name = ?').get(CHI286);
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
    const rebuilt = new Map<string, Record<string, ModelUsage>>();
    const drop: number[] = [];
    let prevSession = '';
    let prevSig = '';
    for (const r of rows) {
      const model = r.model || 'unknown';
      const total = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_w5m_tokens + r.cache_w1h_tokens;
      const sig = `${model}|${r.input_tokens}|${r.output_tokens}|${r.cache_read_tokens}|${r.cache_w5m_tokens}|${r.cache_w1h_tokens}`;
      if (r.session_id !== prevSession) { prevSession = r.session_id; prevSig = ''; }
      // A replay repeats the previous row's cells exactly. `total > 0` is an
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
    const cellTotal = (u: Record<string, ModelUsage>): number => Object.values(u)
      .reduce((n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h, 0);
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
        if (!next || cellTotal(next) === 0) { setUsage.run(s.usage, 'unverified', s.id); unverified++; continue; }
        let prevTotal = 0;
        try { prevTotal = cellTotal(JSON.parse(s.usage) as Record<string, ModelUsage>); } catch { prevTotal = 0; }
        // Never rewrite UPWARD. The message lane is a subset of what the old
        // accumulator summed, so a larger result means an assumption broke.
        if (prevTotal > 0 && cellTotal(next) > prevTotal) { setUsage.run(s.usage, 'unverified', s.id); unverified++; continue; }
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
      db.prepare('INSERT INTO chronicle_migrations (name) VALUES (?)').run(CHI286);
      db.exec('COMMIT');
      console.log(`[chronicle] backfill: ${rederived} sessions re-derived, ${unverified} unverified, ` +
                  `${drop.length} duplicate token rows cleared, ${reimport} queued for exact re-import`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } else {
    db.prepare('INSERT INTO chronicle_migrations (name) VALUES (?)').run(CHI286);
  }
}

// Failure must not kill startup — same rule as the error-count backfill above.
// A second Chronicle process holding a write lock (SQLITE_BUSY) is the likely
// cause; the marker is only written inside the committed transaction, so a
// failed run leaves nothing half-applied and retries on the next boot.
try {
  chi286Backfill();
} catch (err) {
  console.warn('[chronicle] backfill deferred (will retry next start):', (err as Error).message);
}

// Retired: the contract views and the version gate over them are gone. The base
// tables are the only read seam now; nothing outside this repo consumes the
// database. A database written by an older Chronicle still carries both, so
// clear them once — leaving `user_version` at 1 would advertise a contract that
// no longer exists to anyone who does read the pragma.
db.exec(`
DROP VIEW IF EXISTS contract_message_metrics;
DROP VIEW IF EXISTS contract_sessions;
PRAGMA user_version = 0;
`);

// Retired: the write gate (propose -> diff card -> confirm, backup, verify,
// undo) and its audit trail are gone. A database written by an older Chronicle
// still carries the table, so drop it once — nothing reads it any more.
db.exec('DROP TABLE IF EXISTS gate_audit;');

// FTS5 full-text index over message content (external-content table kept in
// sync inside replaceSession — delete+reinsert, no triggers). Node's bundled
// SQLite ships FTS5, but verify at startup and fail soft: search falls back
// to LIKE when the table is missing.
export let ftsAvailable = false;
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
           USING fts5(text, tool_input, content=messages, content_rowid=id)`);
  ftsAvailable = true;
} catch {}

// Snapshot the whole DB. Called before destructive deletes (project/session
// removal, via routes/_shared.ts's backupDbBeforeDelete) and before the usage
// backfill rewrites historical usage. Throttled to at most one snapshot per
// hour so a multi-select Remove loop makes ONE backup, not N; `force` overrides
// that for a one-shot migration, which must always be recoverable. Keeps the
// two newest. Restore = stop the app and copy the snapshot back over
// chronicle.db (delete any -wal/-shm sidecars alongside it first).
export function snapshotDb(force = false): string | null {
  try {
    const dir = path.join(dataDir, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.startsWith('chronicle-')).sort();
    const newest = existing[existing.length - 1];
    if (!force && newest && Date.now() - fs.statSync(path.join(dir, newest)).mtime.getTime() < 60 * 60 * 1000) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `chronicle-${stamp}.db`);
    db.exec('BEGIN'); db.exec('COMMIT'); // barrier: no open write txn while copying
    fs.copyFileSync(path.join(dataDir, 'chronicle.db'), dest);
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
  return !!db.prepare('SELECT 1 FROM session_tombstones WHERE source = ? AND session_id = ?').get(source, sessionId);
}

export function tombstoneSession(source: string, sessionId: string): void {
  db.prepare(`INSERT INTO session_tombstones (source, session_id, deleted_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(source, session_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(source, sessionId);
}

// Undo: forget the tombstone. The source log is untouched, so the caller just
// needs to re-trigger an import/sync afterward to bring the session back.
export function removeTombstone(source: string, sessionId: string): void {
  db.prepare('DELETE FROM session_tombstones WHERE source = ? AND session_id = ?').run(source, sessionId);
}

// Whole-project delete: tombstone every session that belonged to it, so a
// paused-then-resumed auto-sync doesn't resurrect them.
export function tombstoneSessionsForProject(projectId: number | string): void {
  const rows = db.prepare('SELECT id, source FROM sessions WHERE project_id = ?').all(projectId) as unknown as { id: string; source: string }[];
  for (const r of rows) tombstoneSession(r.source, r.id);
}

export function upsertProject(physicalPath: string): ProjectRow {
  const name = path.basename(physicalPath) || physicalPath;
  db.prepare('INSERT INTO projects (path, name) VALUES (?, ?) ON CONFLICT(path) DO NOTHING').run(physicalPath, name);
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(physicalPath) as unknown as ProjectRow;
}

export function replaceSession(session: SessionInput, events: Event[]): void {
  // Tombstoned sessions must never be resurrected by a re-scan of the same
  // source file — check BEFORE touching the DB, from every import path
  // (manual import, per-project/per-session sync, auto-sync).
  if (isTombstoned(session.source, session.id)) return;
  db.exec('BEGIN');
  try {
    // Preserve a user-set display name, and a promoted-out-of-minor state,
    // across re-imports (delete + reinsert).
    const prev = db.prepare('SELECT name, minor FROM sessions WHERE id = ?').get(session.id) as { name: string | null; minor: number | null } | undefined;
    if (ftsAvailable) {
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
    if (ftsAvailable) {
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
