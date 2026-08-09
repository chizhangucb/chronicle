import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { agentActiveMs, engagedMs } from './durations.js';

const dataDir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));

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
try { db.exec('ALTER TABLE messages ADD COLUMN is_sidechain INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN agent_type TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN skill TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_w5m_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN cache_w1h_tokens INTEGER'); } catch {}

// Contract views: the dashboard reads ONLY these; base tables stay free to
// refactor. user_version bumps only on breaking view changes.
db.exec(`
DROP VIEW IF EXISTS contract_message_metrics;
CREATE VIEW contract_message_metrics AS
SELECT m.session_id, m.seq, m.ts, m.kind, m.model,
       m.is_sidechain, m.agent_type, m.skill,
       m.tool_name,
       CASE WHEN m.tool_name LIKE 'mcp__%'
            THEN substr(m.tool_name, 6, instr(substr(m.tool_name, 6), '__') - 1)
       END AS mcp_server,
       m.input_tokens, m.output_tokens, m.cache_read_tokens,
       m.cache_w5m_tokens, m.cache_w1h_tokens,
       s.file_path AS source_file
FROM messages m JOIN sessions s ON s.id = m.session_id;
DROP VIEW IF EXISTS contract_sessions;
CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage,
       s.agent_active_ms, s.engaged_ms
FROM sessions s JOIN projects p ON p.id = s.project_id;
PRAGMA user_version = 1;
`);

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

export function upsertProject(physicalPath) {
  const name = path.basename(physicalPath) || physicalPath;
  db.prepare('INSERT INTO projects (path, name) VALUES (?, ?) ON CONFLICT(path) DO NOTHING').run(physicalPath, name);
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(physicalPath);
}

export function replaceSession(session, events) {
  db.exec('BEGIN');
  try {
    // Preserve a user-set display name across re-imports (delete + reinsert).
    const prev = db.prepare('SELECT name FROM sessions WHERE id = ?').get(session.id);
    if (ftsAvailable) {
      db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text, tool_input)
                  SELECT 'delete', id, COALESCE(text,''), COALESCE(tool_input,'')
                  FROM messages WHERE session_id = ?`).run(session.id);
    }
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    const sidechainCount = events.reduce((n, e) => n + (e.is_sidechain ? 1 : 0), 0);
    db.prepare(`INSERT INTO sessions (id, project_id, source, file_path, started_at, ended_at, message_count, first_prompt, context_tokens, name, summary, usage,
                                      sidechain_count, agent_active_ms, engaged_ms, imported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.project_id, session.source, session.file_path,
           session.started_at, session.ended_at, events.length, session.first_prompt,
           session.context_tokens ?? null, session.name ?? prev?.name ?? null,
           session.summary ?? null, session.usage ?? null,
           sidechainCount, agentActiveMs(events), engagedMs(events), new Date().toISOString());
    const ins = db.prepare(`INSERT INTO messages (session_id, seq, uuid, ts, kind, text, tool_name, tool_input, tool_use_id, model,
                                                  is_sidechain, agent_type, skill, input_tokens, output_tokens, cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    events.forEach((e, i) => ins.run(session.id, i, e.uuid ?? null, e.ts ?? null, e.kind,
      e.text ?? null, e.tool_name ?? null, e.tool_input ?? null, e.tool_use_id ?? null, e.model ?? null,
      e.is_sidechain ? 1 : 0, e.agent_type ?? null, e.skill ?? null,
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
}
