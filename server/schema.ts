// server/schema.ts
// Every table Chronicle's database has, in one module (issue #275, audit F13).
// Nothing here runs on import: `applySchema(db)` is called by openDatabase()
// in server/db.ts and by nothing else. A table declared on some other module's
// import appeared and disappeared with that module's import graph (issue #264),
// and a schema that ran on db.ts's own import meant a test could not open a
// second database at all — both are the same bug, and this module is the fix.
//
// The order below is the order it must run in: create, then the idempotent
// ALTERs that carry an older database forward, then the retired-object drops,
// then the FTS probe.
import type { DatabaseSync } from 'node:sqlite';

/** Create every table and index, migrate an older database forward, drop what
 *  Chronicle retired, and probe FTS5. Idempotent: safe on every open.
 *  Returns whether the full-text index is available (search falls back to LIKE
 *  when it is not). */
export function applySchema(db: DatabaseSync): boolean {
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
  -- The operator's own redaction and allow rules, read and written by
  -- server/security.ts. Declared here, not there, because this module is the one
  -- place a table is declared: schema that ran on some other module's import
  -- appeared and disappeared with that module's import graph (issue #264).
  CREATE TABLE IF NOT EXISTS security_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,          -- glob: * = any length, ? = single char
    replacement TEXT DEFAULT '****',
    kind TEXT NOT NULL DEFAULT 'redact',  -- 'redact' | 'allow'
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin_override TEXT           -- if set, disables that builtin rule id
  );
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
  // Provenance of sessions.usage — see SessionRow.usage_source (shared/rows.ts).
  try { db.exec('ALTER TABLE sessions ADD COLUMN usage_source TEXT'); } catch {}
  // Explicit one-shot migration ledger. A data-shaped gate (e.g. "usage_source IS
  // NULL") is NOT safe here: replaceSession enumerates its INSERT columns, so any
  // re-import resets that column and a data-gated migration would re-run on the
  // next boot, forever.
  db.exec(`CREATE TABLE IF NOT EXISTS chronicle_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);


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

  // Retired with it: pre-tool-use interception (issue #264). Chronicle once
  // scanned a tool call before the model saw it and recorded what it blocked.
  // The hook that called it went with the shrink, so the record has had no
  // writer and no reader since; drop the table the same way.
  db.exec('DROP TABLE IF EXISTS interceptions;');

  // Retired: Chronicle's record of which of its own surfaces were looked at is
  // gone. A data folder written by an older Chronicle still carries the table, so
  // drop it once (its index goes with it). Nothing reads either, and the app
  // records nothing to put back.
  // Fail soft, same rule as the backfills above: on the one boot that actually
  // drops it this is a real write, so a second Chronicle holding the write lock
  // (SQLITE_BUSY) would otherwise take startup down with it. A skipped drop costs
  // a dead table until the next boot retries.
  try {
    db.exec('DROP TABLE IF EXISTS view_log;');
  } catch (err) {
    console.warn('[chronicle] view_log drop deferred (will retry next start):', (err as Error).message);
  }

  // FTS5 full-text index over message content (external-content table kept in
  // sync inside replaceSession — delete+reinsert, no triggers). Node's bundled
  // SQLite ships FTS5, but verify at open time and fail soft: search falls back
  // to LIKE when the table is missing.
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
             USING fts5(text, tool_input, content=messages, content_rowid=id)`);
    return true;
  } catch {
    return false;
  }
}
