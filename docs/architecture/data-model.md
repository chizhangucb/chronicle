# Data Model

Chronicle stores everything in a single local SQLite database — three tables (`projects`, `sessions`, `messages`) — and every parser flattens its tool-native log into one normalized event shape so the UI never has to care where a session came from.

This page covers the datastore (`server/db.js`), the three tables and their migration columns, the normalized event model shared by all six parsers, and `replaceSession()` — the idempotent import transaction that quietly preserves the one thing users type by hand.

## The datastore

The database lives at `~/.chronicle/chronicle.db`, opened through Node's built-in SQLite:

```js
// server/db.js
import { DatabaseSync } from 'node:sqlite';
const dataDir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));
```

Two decisions matter here:

- **`node:sqlite`, not better-sqlite3.** It ships with Node, so there is no native module to compile or rebuild per platform — a hard requirement for a zero-toolchain build. Override the data directory with `CHRONICLE_DATA_DIR` (handy for tests and throwaway instances).
- **Schema is created idempotently at module load.** `db.exec()` runs the full `CREATE TABLE IF NOT EXISTS …` block every time the module loads, and schema changes are applied as best-effort migrations:

```js
// Idempotent migrations — safe to run on every boot
try { db.exec('ALTER TABLE sessions ADD COLUMN context_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN name TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT'); } catch {}
```

There is no migration framework and no version table. A new column is a `try { ALTER TABLE … } catch {}` line: the first boot after an upgrade adds it, every later boot no-ops in the `catch`. This is enough because the schema is small and only ever grows, and it keeps the "just run it" property — no separate migration step to forget.

## The three tables

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,          -- physical cwd (or a gemini-project:<hash> virtual path)
  name TEXT NOT NULL,                 -- basename(path), shown on the project card
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- the tool's own session id
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,              -- claude-code | codex | cursor | opencode | gemini-cli | copilot-chat
  file_path TEXT NOT NULL,          -- source log this session was parsed from
  started_at TEXT, ended_at TEXT,
  message_count INTEGER DEFAULT 0,
  first_prompt TEXT
  -- migration columns: context_tokens, name, summary, usage
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,             -- 0-based order within the session
  uuid TEXT, ts TEXT,
  kind TEXT NOT NULL,               -- user|assistant|thinking|tool_use|tool_result|note
  text TEXT,
  tool_name TEXT, tool_input TEXT,  -- tool_input is a JSON string
  tool_use_id TEXT,                 -- pairs a tool_use with its tool_result
  model TEXT
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id);
```

**`projects`** is keyed on `path` — the physical `cwd` recorded in the logs (or a virtual `gemini-project:<hash>` when the tool records no cwd). One physical directory is one logical project no matter how many tools worked in it. `upsertProject(physicalPath)` inserts-or-ignores on the unique `path` and returns the row.

**`sessions`** carries the identity and summary fields. The base columns are the original schema; the four **migration columns** were added later, which is exactly why they are `ALTER TABLE`s rather than part of the `CREATE`:

| Column | Populated from | Why it's a migration |
| --- | --- | --- |
| `context_tokens` | prompt side of the last main-chain API call | added when the context-window bar shipped; **only set on import** — re-import or Sync Update to backfill after upgrading |
| `name` | user-typed rename in Chronicle | added when inline rename shipped; the only user-authored field in the table |
| `summary` | parsed tool title (Claude Code `custom-title`, last wins) | added when auto-titles shipped; re-derived every import |
| `usage` | per-model token totals as JSON | added when the Cost & Usage panel shipped; re-derived every import |

The `usage` JSON is shaped `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}` — 5-minute and 1-hour cache writes are kept split because they bill at different rates (see [Session insights](../guide/session-insights.md)).

**`messages`** is the normalized event stream, ordered by `seq` within a session. The `(session_id, seq)` index is what makes windowed playback cheap — the UI renders ~400 rows around the selection, so it slices by `seq` rather than loading a 6,000-message session into the DOM.

## The normalized event model

Every parser's job is to turn a tool-native log into a flat list of rows of one shape. That shape is the contract between ingestion and everything downstream — playback, refine, causality, search, and share all read the same rows.

The **kinds**:

| `kind` | Meaning | Label (`src/kinds.js`) |
| --- | --- | --- |
| `user` | a human prompt or an inserted user turn | User |
| `assistant` | model prose | Assistant |
| `thinking` | extended-thinking block | Thinking |
| `tool_use` | a tool call (has `tool_name`, `tool_input`, `tool_use_id`) | Tool Call |
| `tool_result` | a tool's output (has `tool_use_id`) | Tool Result |
| `note` | a Refine-inserted annotation | Inserted |

Each event row populates a subset of: `ts`, `kind`, `text`, `tool_name`, `tool_input` (a JSON *string*, so arbitrary tool schemas fit one column), `tool_use_id`, `uuid`, `model`. The `tool_use_id` is the join key: a `tool_use` and the `tool_result` it produced carry the same id, which is how the UI pairs a call with its output even when other messages sit between them.

> **One source of truth for labels.** The human-readable name and icon for each kind live only in `src/kinds.js` (`KIND_LABEL` / `KIND_ICON`). Playback (`SessionView`) and Refine (`RefineMode`) both import them, so the vocabulary can't drift — an earlier version had Playback saying "You"/"AI" while Refine said "USER"/"ASSISTANT". Put new wording there, never inline.

Because the model is normalized, the difference between six tools collapses to which fields a given parser fills. A Cursor tool call and a Claude Code tool call are the same row by the time they reach the database — see [Parsers & ingestion](parsers-and-ingestion.md) for how each tool maps in.

## `replaceSession()` — idempotent import

Import is not an upsert-per-row; it is a full **delete-and-reinsert of one session inside a transaction**. Re-importing the same log produces the same rows, so Sync Update and re-import are safe to run repeatedly.

```js
// server/db.js — abridged
export function replaceSession(session, events) {
  db.exec('BEGIN');
  try {
    const prev = db.prepare('SELECT name FROM sessions WHERE id = ?').get(session.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.prepare(`INSERT INTO sessions (..., name, summary, usage) VALUES (..., ?, ?, ?)`)
      .run(/* … */ session.name ?? prev?.name ?? null,
                   session.summary ?? null, session.usage ?? null);
    // reinsert every event with seq = its index
    events.forEach((e, i) => ins.run(session.id, i, /* … */));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
```

The subtle part is the first line inside the transaction. Because the row is about to be deleted, a naive reinsert would wipe any rename the user typed. So `replaceSession` **reads `prev.name` first and falls back to it** (`session.name ?? prev?.name ?? null`). The result:

- **`name` survives re-import** — a Chronicle rename is user-authored and must not be clobbered by re-parsing the log.
- **`summary`, `usage`, `context_tokens` are re-derived every import** — they come from the log, so the freshest parse wins.

> **Note — a stale build can wipe titles.** An older packaged app that predates the `name` column but shares the same `~/.chronicle/chronicle.db` doesn't know to preserve it, and will drop renames on any sync. Quit stray instances before debugging a "my rename vanished" report.

This is also the single reason import order and idempotency compose cleanly: the whole session is one atomic swap, so a crash mid-import rolls back rather than leaving half a session behind.

## Related
- [Parsers & ingestion](parsers-and-ingestion.md) — how each tool's log becomes these normalized rows, plus a HOWTO for adding a source.
- [Importing sessions](../guide/importing-sessions.md) — the user-facing import wizard and read-only guarantees.
- [Architecture overview](overview.md) — where the datastore sits in the whole system.
