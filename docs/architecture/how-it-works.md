# How It Works

Chronicle is a local-first "time machine" for AI coding sessions: it imports conversation
logs from four tools, maps every message to the Git snapshot at that moment, and adds
security redaction, live streaming, invisible background sync, and a cross-project Insights
engine — all in a single Node process with no cloud backend and no LLM calls.

This page is the whole architecture, top to bottom: the one design decision everything else
hangs off (single process, single port), the data model, ingestion, the Git snapshot engine,
invisible sync, and the Insights engine. Read it once; it's the map for the rest of the
codebase.

## Single process, single port

Chronicle is one Express app and a React UI. The app (`server/api.ts`) mounts every route
group under `/api`:

| Route file (`server/routes/`) | Responsibility |
| --- | --- |
| `import-sync.ts` | Scan/import, per-project and per-session sync |
| `projects.ts` | Project list, detail, associate/unlink, delete |
| `sessions.ts` | Session detail, rename, delete/undo (tombstones), minor-session bucket, live SSE, causality |
| `search.ts` | Global search (FTS5, `LIKE` fallback) |
| `security.ts` | Security scan, redaction rules, redacted export |
| `git.ts` | Snapshot queries (`/git/at`, `/git/tree`, `/git/file`) |
| `insights.ts` | Cross-project Insights (Overview tab) |
| `explore.ts` | The Explore pivot table |
| `content.ts` | The Content composition tab |
| `settings.ts` | Auto-sync on/off/pause, noise-gate thresholds |

The key move: **the exact same app object is served in every run mode.** In development it's
mounted *into* the Vite dev server; in production a plain Express server
(`server/standalone.ts`) mounts it directly and serves the built `dist/` for everything else.
Add an endpoint to `server/routes/` and it works in dev and in `npm run standalone` for free —
no per-mode wiring, and it's exactly what `npx chronicle-cli` runs under the hood.

In dev, `vite.config.js` installs a small plugin that hangs middleware off Vite's connect
server and loads the API lazily per request via `ssrLoadModule` — so **editing `server/*.ts`
hot-reloads the API** without restarting the process, on the same port as the UI (`4173`).

In production there is no Vite. `server/standalone.ts` builds an Express app, mounts the same
API, and serves the built `dist/` for everything else — this is exactly what runs when you
`npx chronicle-cli`.

> **Gotcha — mount an Express *app*, not a Router.** The Vite middleware hands the app a raw
> Node `req`/`res`. An Express *Router* does not decorate those objects, so `res.json` is
> `undefined` and every route throws. Mounting a full Express *application* is what makes the
> same code run behind Vite and behind `standalone.ts`.

## `.ts` runs natively — no build step for the server

Chronicle's server executes `.ts` files directly: Node 24 strips TypeScript types at load time,
so `import './db.ts'` just works, with no transpiler and no compiled server bundle in
development. `tsc` (`npm run typecheck`) is a **type checker only** here — the gate is that it
exits 0, not that it produces output anyone runs.

The one place a real compile happens is **publishing**: `npm run prepack` runs
`tsc -p tsconfig.publish.json` to emit a compiled server tree (`dist-server/`), because a
published npm package's `.ts` files sit under `node_modules` where Node's type-stripping loader
doesn't apply the same way to a *dependency's* source. `bin/chronicle.mjs` (the `npx` entry
point) imports the compiled `dist-server/server/standalone.js`, not the `.ts` source.

## Component map

```
┌──────────────────────────────────────────────────────────────┐
│  bin/chronicle.mjs — the npx/CLI launcher                     │
│  Node 24 check, port scan, spawns the browser, Ctrl-C to stop │
└───────────────────────────┬──────────────────────────────────┘
                            │ starts
┌───────────────────────────▼──────────────────────────────────┐
│  Server layer (Node, node:sqlite, shells out to git)          │
│                                                               │
│  parsers/      claudeCode · codex · cursor · opencode         │
│                → normalized events                            │
│  db.ts         projects / sessions / messages  (SQLite)       │
│  git.ts        read-only snapshot engine (rev-list/ls-tree)   │
│  live.ts       JSONL tail + SQLite poll → SSE                 │
│  autosync.ts   invisible background sync (watchers, backstop) │
│  noiseGate.ts  "minor session" bucketing                      │
│  causality.ts  read→change linking (heuristic)                │
│  security.ts   redaction rules, session scan                  │
│  insights.ts   explore.ts   content.ts   calibrate.ts         │
│                → the Insights engine (Overview/Explore/Content)│
│                                                               │
│  Exposed as one Express app → /api                            │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────────┐
│  React UI (src/) — plain React + one styles.css               │
│  App.tsx global sidebar (Projects · Insights)                 │
│  HomePage · ProjectDetail · SessionView · InsightsPage         │
└──────────────────────────────────────────────────────────────┘
```

## Run modes

Two modes serve the same app; they differ only in what wraps it.

| Command | What runs | Port | Notes |
| --- | --- | --- | --- |
| `npm run dev` | Vite dev server + API mounted via the plugin | `http://localhost:4173` | UI HMR **and** API hot-reload (`ssrLoadModule`) |
| `npm run standalone` | `server/standalone.ts`, headless | `41730` (override with `PORT`) | Binds `127.0.0.1`; UI + `/api`; this is what `npx chronicle-cli` runs |

`npx chronicle-cli` is a thin launcher (`bin/chronicle.mjs`) around the standalone server: it
checks the Node version, finds a free port, calls `startServer()`, and opens the browser. There
is no desktop shell, no tray, and no background daemon — the server runs in the foreground of
your terminal and stops on `Ctrl-C`. Long-lived state (auto-sync watchers/timers, live-tail
watchers) lives on `globalThis` so a Vite SSR module reload in dev doesn't orphan them.

## Product principles

1. **Local-first.** Parsing, viewing, and managing a session require no network call, and there
   is no telemetry, analytics, or update check. The one outbound request is opt-out: the
   **Claude plan windows** feature reads your own subscription quota from api.anthropic.com
   (the same call Claude Code makes), on by default and off with one Settings toggle for a
   fully offline instance; Codex plan windows are read locally.
2. **Git is the source of truth for code state.** Snapshots are reconstructed from commit
   history matched to conversation timestamps — never from a separate snapshot store, never
   from current disk.
3. **Read-only on foreign systems.** Source logs and project repos are never written. SQLite
   sources are copied to temp before opening; the git engine only reads.
4. **Safe by default.** Redaction is one-way; destructive operations (delete session, delete
   project) back up the database first and tombstone rather than silently discard.
5. **Everything heavy is heuristic + local.** Causality confidence tiers, redaction regexes,
   active-duration math, Insights aggregation, token calibration — all local heuristics.
   **No LLM calls anywhere.**

### Key stack decisions

- **`node:sqlite` (`DatabaseSync`), not better-sqlite3.** Zero native compilation, so the
  package installs and runs without a compiler on the target machine — this is also why
  Node 24+ is required.
- **The git engine shells out to `git`** (`execFileSync`) rather than linking libgit2 — no
  native dependency, and it matches whatever `git` the developer already trusts.
- **Plain React + one `styles.css`**, hand-rolled and Recharts-backed charts — no heavyweight
  UI framework.
- **Dependency discipline:** only the genuine server-runtime dependency (`express`) lives in
  `dependencies`; every client library (`react`, `react-dom`, `recharts`, `wouter`, `diff`,
  the Radix packages) is a `devDependency`, because Vite bundles them into `dist/` at build
  time and the published npm package only ships `bin/`, `dist/`, and `dist-server/`.

## Data model

Chronicle stores everything in a single local SQLite database at `~/.chronicle/chronicle.db`
(override: `CHRONICLE_DATA_DIR`) — three core tables (`projects`, `sessions`, `messages`) plus
a `session_tombstones` table — and every parser flattens its tool-native log into one
normalized event shape so the UI never has to care where a session came from.

```ts
// server/db.ts
import { DatabaseSync } from 'node:sqlite';
export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));
```

The schema is created idempotently at module load (`CREATE TABLE IF NOT EXISTS …`), and
changes since are applied as best-effort migrations — `try { db.exec('ALTER TABLE …') } catch
{}` lines. There is no migration framework and no version table: the first boot after an
upgrade adds a column, every later boot no-ops in the `catch`.

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,          -- physical cwd
  name TEXT NOT NULL,                 -- basename(path), shown on the project card
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- the tool's own session id
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,              -- claude-code | codex | cursor | opencode
  file_path TEXT NOT NULL,          -- source log this session was parsed from
  started_at TEXT, ended_at TEXT,
  message_count INTEGER DEFAULT 0,
  first_prompt TEXT
  -- migration columns: context_tokens, name, summary, usage, sidechain_count,
  --                    agent_active_ms, engaged_ms, imported_at, minor
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,             -- 0-based order within the session
  uuid TEXT, ts TEXT,
  kind TEXT NOT NULL,               -- user|assistant|thinking|tool_use|tool_result
  text TEXT,
  tool_name TEXT, tool_input TEXT,  -- tool_input is a JSON string
  tool_use_id TEXT,                 -- pairs a tool_use with its tool_result
  model TEXT
  -- migration columns: is_sidechain, agent_type, skill, and five per-message
  --                    token columns (input/output/cache_read/cache_w5m/cache_w1h)
);

CREATE TABLE session_tombstones (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deleted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, session_id)
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_messages_tooluse ON messages(session_id, tool_use_id);
```

**`projects`** is keyed on `path` — the physical `cwd` recorded in the logs. One physical
directory is one logical project no matter how many tools worked in it.

**`sessions`** carries identity and summary fields, plus migration columns added over time:
`context_tokens` (prompt side of the last main-chain API call, only set on import), `name` (a
user-typed rename in Chronicle — the only user-authored field in the table), `summary` (parsed
tool title, re-derived every import), `usage` (per-model token totals as JSON, shaped
`{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`), `sidechain_count` (a
denormalization for cards/Insights), the stored duration metrics `agent_active_ms` /
`engaged_ms`, `imported_at` (drives incremental auto-sync), and `minor` (the noise-gate flag —
see Invisible sync below).

**`messages`** is the normalized event stream, ordered by `seq` within a session. The
`(session_id, seq)` index is what makes windowed playback cheap. `(session_id, tool_use_id)`
is a second index added specifically for the Insights engine — Explore and Content both
self-join `tool_use`↔`tool_result` pairs, and without it that join degrades to a per-session
linear scan; adding it cut those endpoints from tens of seconds to ~1s on a large real
database. `is_sidechain` (1 = subagent event — Claude Code only), `agent_type` (subagent type),
and `skill` (active skill context) support subagent attribution across the Overview Subagents
card and the Insights Explore/Content tabs. Five per-message token columns are stored on the
first event of each API call, which is what unlocks costliest-message rankings. **The database
stores tokens, never dollars**; `src/models.ts` computes cost client-side from a static price
table.

**`session_tombstones`** records a deliberate delete (single session or whole-project) keyed on
`(source, session_id)`. Every import path — manual import, per-project/per-session sync,
auto-sync — checks this table before inserting, so a tombstoned session is never resurrected by
a later scan of the same source log. "Undo" just removes the tombstone row.

### The normalized event model

Every parser's job is to turn a tool-native log into a flat list of rows of one shape — the
contract between ingestion and everything downstream (playback, refine, causality, search,
Insights).

| `kind` | Meaning | Label (`src/kinds.ts`) |
| --- | --- | --- |
| `user` | a human prompt or an inserted user turn | User |
| `assistant` | model prose | Assistant |
| `thinking` | extended-thinking block | Thinking |
| `tool_use` | a tool call (has `tool_name`, `tool_input`, `tool_use_id`) | Tool Call |
| `tool_result` | a tool's output (has `tool_use_id`) | Tool Result |

Each event row populates a subset of: `ts`, `kind`, `text`, `tool_name`, `tool_input` (a JSON
*string*), `tool_use_id`, `uuid`, `model`. `tool_use_id` is the join key: a `tool_use` and the
`tool_result` it produced carry the same id.

> **One source of truth for labels.** `src/kinds.ts` (`KIND_LABEL` / `KIND_ICON`) is imported
> by both Playback and Refine, so the vocabulary can't drift. Put new wording there, never
> inline.

### `replaceSession()` — idempotent import

Import is not an upsert-per-row; it is a full **delete-and-reinsert of one session inside a
transaction**. Re-importing the same log produces the same rows, so incremental auto-sync and
manual re-import are safe to run repeatedly:

```ts
// server/db.ts — abridged
export function replaceSession(session: SessionInput, events: Event[]): void {
  if (isTombstoned(session.source, session.id)) return; // deliberately deleted — never resurrect
  db.exec('BEGIN');
  try {
    const prev = db.prepare('SELECT name, minor FROM sessions WHERE id = ?').get(session.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    const minor = prev?.minor === 0 ? 0 : (isMinorSession(activeMs, events.length) ? 1 : 0);
    db.prepare(`INSERT INTO sessions (..., name, ...) VALUES (..., ?, ...)`)
      .run(/* … */ session.name ?? prev?.name ?? null, /* … */ minor);
    events.forEach((e, i) => ins.run(session.id, i, /* … */));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
```

Two things survive re-import on purpose: a Chronicle **rename** (`prev.name`) and a session
**promoted out of the minor bucket** (`prev.minor === 0`) — otherwise every re-sync would
silently undo either.

### FTS5 full-text index

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```

An external-content FTS5 table over `messages.text` and `tool_input`, kept in sync inside
`replaceSession` — because import is a delete-and-reinsert, rebuilding the session's FTS rows
in the same transaction keeps the index consistent without triggers. `GET /api/search` uses
FTS5 `MATCH` and falls back to `LIKE` if the FTS table is missing, grouped per session (empty
query → recent sessions, which is what backs Home's default stream).

### Token provenance on the base tables

Chronicle's base tables are the only read seam; there are no compatibility views over them
(the retired `contract_*` views and their `PRAGMA user_version` gate are gone).
Two columns are worth calling out because they carry provenance rather than data.

`sessions.usage_source` is the provenance of a session's token magnitudes, so a reader can
**label** rebuilt numbers instead of presenting them as measured. `exact` means the transcript
was re-parsed by the fixed parser. `rederived` means Claude Code had already pruned the
transcript, so the CHI-286 migration rebuilt the numbers structurally from the surviving
per-message rows; those read **low**, by 6.7% and 15.1% in the two sessions audited against
the CLI's own usage report. `unverified` means neither was possible and the pre-fix inflated
value stands, so it reads high. `NULL` means there was no per-call id to claim `exact` from
(codex and cursor carry none) or the row predates the column. The message rows follow the
session: the rederived lane cleared the replayed rows it collapsed, so summing
`messages`' token columns agrees with `sessions.usage` for `rederived` and disagrees for
`unverified`.

`messages.message_id` and `messages.request_id` are Anthropic's own per-API-call identity.
They matter because `seq` and the underlying `uuid` are per transcript **line**, and Claude
Code splits one API response's content blocks across several lines — an empty `thinking`
block, then text, then `tool_use` — each repeating the full `usage` payload. Chronicle
attaches a call's tokens to exactly one row, so summing the token columns is already correct;
the pair is kept so a later pass can verify that or join the rows belonging to one call.

## Ingestion: scan, then import

Every parser lives in `server/parsers/<tool>.ts` and exports two kinds of function:

- **`scan<Tool>Projects()`** — cheap, read-only. Lists importable projects/sessions with size
  estimates, without parsing message bodies. Backs the import wizard.
- **A parse function** — reads a session's native log and returns `{ session, events }`.

The four parsers wired in today:

| Tool | Source key | File / dir (env override) | Format |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` | JSONL |
| Codex | `codex` | `~/.codex/sessions/` | JSONL |
| Cursor | `cursor` | VS Code `workspaceStorage` (`CHRONICLE_CURSOR_DIR`) | SQLite (WAL) |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | SQLite (WAL) |

`GET /api/scan` fans out to all four scanners and annotates which sessions are already
imported; `POST /api/import` routes the chosen source to the right parse function, then hands
each `{ session, events }` to `replaceSession()`.

> **Read-only, always.** Scanning and importing only read source logs. The write side of
> ingestion touches nothing but `~/.chronicle/chronicle.db`.

### Per-tool notes

**Claude Code JSONL — filter the noise.** The parser skips `isSidechain` entries into a
separate attribution path (see below), skips `<command-name>`/`<local-command…>` user strings
and `<system-reminder>` text blocks (not real prompts), and pairs `tool_use`/`tool_result` by
`tool_use_id`. The session's auto-title comes from `{"type":"custom-title","customTitle":…}`
lines — the `/rename` title, last one wins.

**Sidechain (subagent) attribution — Claude Code only.** The parser imports sidechain lines
(rather than dropping them) and marks them `is_sidechain = 1`, then derives `agent_type` by
pairing the sidechain's first user message with the main chain's `Task` tool-call input
(`subagent_type`). `skill` is set on a `Skill` tool-call row and on `<command-name>` turns.
Scope rule: `context_tokens` stays main-chain-only (matching Claude Code's own status line);
Cost & Usage and Agent Active *include* sidechains; default message counts, Playback, and
Refine *exclude* them. Subagent runs surface in a session's Overview (a dedicated card,
drill-in to that subagent's transcript) and as a first-class dimension in Insights' Explore
(group/subgroup by "subagent") and Content ("Skills & subagents" panel) tabs.

**Cursor & OpenCode — copy the WAL, never open live.** Both store chats in SQLite databases the
running editor may still be writing. Chronicle copies the DB to a temp directory **including
the `-wal` and `-shm` sidecar files** before opening it read-only — in WAL mode the newest
writes live in the `-wal` file, so copying only the `.db` yields a snapshot missing recent (or
all) rows.

**cwd resolution — latest wins, collapse to an ancestor.** A session resumed after a repo move
keeps the *old* path in its early records; the scanner sniffs the head and tail 64 KB of each
log file to find the newest cwd, and `reduceCwd()` collapses subdirectory cwds up to the
shortest seen ancestor so a project's sessions group together.

### HOWTO: add a new source

1. **Write `server/parsers/newtool.ts`** exporting `scanNewtoolProjects()` (cheap listing) and
   a parse function returning `{ session, events }` where each event is a normalized row
   (`{ ts, kind, text?, tool_name?, tool_input?, tool_use_id?, uuid?, model? }`). Populate
   `cwd` on the session; if the source is a WAL SQLite DB, copy the `-wal`/`-shm` sidecars to
   temp exactly as Cursor/OpenCode do.
2. **Wire it into `server/routes/import-sync.ts`** — import the two functions, add it to the
   scanner map for `GET /scan`, and add a branch so `POST /import` routes to it. Add it to
   `server/autosync.ts`'s per-source loop too, so it participates in invisible sync.
3. **Add it to `SOURCES` in `src/ImportWizard.tsx`** with a matching `key`.
4. **Validate against a fixture, then real data.** Drop a sample log in `test/fixtures/` and
   confirm scan lists it and import produces sane rows; then import a real session and
   time-travel through it.

## Git snapshot engine

Time travel works because Chronicle treats **Git history as the source of truth for code
state**. `server/git.ts` reconstructs "what the code looked like at this message" by matching
the message's timestamp to a commit and reading files out of it — read-only, shelling out to
`git`, never a separate snapshot store and never current disk.

Every function goes through one helper: `execFileSync('git', ['-C', repo, ...args], ...)`.
There is no libgit2. Every call is a query (`rev-list`, `ls-tree`, `show`, `diff-tree`,
`rev-parse`, `log`); nothing checks out, resets, or writes.

| Function | Git plumbing | Returns |
| --- | --- | --- |
| `isGitRepo(dir)` | `rev-parse --is-inside-work-tree` | boolean |
| `repoInfo(dir)` | `rev-list --count HEAD`, `rev-parse --abbrev-ref HEAD` | `{ isRepo, commitCount, branch }` |
| `commitsBetween(dir, from, to)` | `log --all --since --until` (±10 min pad) | commits for timeline ticks |
| `commitAt(dir, ts)` | `rev-list -1 --before=ts --all` | nearest commit at-or-before `ts` |
| `treeAt(dir, commit)` | `ls-tree -r --name-only` | file paths in that commit |
| `fileAt(dir, commit, file)` | `show commit:file` (+ previous version) | `{ content, previous, prevCommit, changedInCommit }` |
| `changedFiles(dir, commit)` | `diff-tree -m --first-parent` | files changed in the commit |

**`repoInfo()` has no caching** — it runs `git` on every `/api/projects` call, so the
project-card git pill (branch + commit count) is always live and accurate. `commitCountSinceAsync`
(used by the Insights Overview commit count) runs these concurrently across projects instead of
serially, which is what keeps the Insights page fast with many projects.

**`commitAt()` picks the nearest commit at or before the timestamp**, with a fallback: when a
message predates the repo's first commit, the engine falls back to the **oldest** commit and
sets `beforeHistory: true`.

The time-travel data flow: select a message → `commitAt(dir, ts)` → the nearest commit →
`treeAt()` (file tree) and `fileAt()` (content + previous version for diff). The API exposes
this as `GET /api/git/at`, `GET /api/git/tree`, `GET /api/git/file`. Because state is always
reconstructed from history, **fidelity tracks commit frequency** — uncommitted work between two
commits is invisible to the engine.

**Merge commits are the one place naive `diff-tree` lies** — against a merge, `diff-tree` with
default options produces an *empty* diff. Both `fileAt()` and `changedFiles()` pass `-m
--first-parent` so the diff is computed against the mainline before the merge.

## Invisible sync

Chronicle never asks you to manually re-import. `server/autosync.ts` runs an **incremental**
background sync so the database stays fresh as you keep using your AI tools:

- **Triggers:** on server start, a debounced (~30s) filesystem watch on the known log
  directories, and a 30-minute backstop timer that catches anything the fs-watch missed (macOS
  can drop fs events across sleep).
- **Incremental:** per-file sources (Claude Code, Codex) are pre-filtered by mtime — only
  sessions whose source file changed since their last import get re-parsed. DB-backed sources
  (Cursor, OpenCode) re-parse their whole store only when its file is newer than the last
  import from it.
- **Idempotent by construction:** every pass calls the same `replaceSession()` used by manual
  import, so a partial or repeated sync just supersedes the previous state — nothing needs
  special-case "in progress" handling.
- **Scoped to known projects:** auto-sync never creates a new project on its own; it only
  updates sessions belonging to projects you've already imported into.
- **Pausable, not just on/off:** turning auto-sync **off** tears down the watchers and timer
  entirely. **Pausing** (a separate toggle in Settings) keeps them registered — so resuming
  needs no restart — but every sync attempt they trigger no-ops. Manual actions (a session's
  "Sync Update" button, `⇧⌘U`) call the import path directly and are never blocked by pause.

**Deletes are tombstones, not silent drops.** Deleting a session or a whole project writes to
`session_tombstones` (after backing up the database) rather than just removing rows — so a
subsequent auto-sync pass of the same source log can't resurrect something you deliberately
removed. "Undo" is just forgetting the tombstone; the source log was never touched either way.

**The noise gate keeps low-signal sessions out of your way.** `server/noiseGate.ts` flags a
session `minor` at import time when its agent-active time and message count both fall under
small default thresholds (tunable in `~/.chronicle/config.json`). Minor sessions are excluded
from the main lists and Insights aggregates by default, collected instead into a single
collapsible "Minor sessions" bucket on Home with Promote/Ignore actions. Promoting a session out
of the bucket is sticky across re-import (see `replaceSession` above).

## Security & live streaming

### Security engine (`server/security.ts`)

Turns text into `{ findings, redacted }`. Built-in regex detectors (`api_key`, `password`,
`token`, `db_conn`, `email`, `phone`, `private_ip`) run in an order that matters — `db_conn`
before `email`/`password` so a connection string redacts as a whole rather than getting
shredded into separate matches. Custom rules are **globs** (`*`/`?`) compiled to regex, either
a `redact` rule or an `allow` rule that protects a span. `scanText()` resolves overlaps by
priority: allow-list wins first, then custom rules before built-ins, then earlier match wins on
overlap. `scanSession(messages)` is the batch path used by the Security Check panel and the
redacted Markdown export.

> **Contributor gotcha.** The "is this tool result an error?" check has one server-side copy,
> `server/errors.ts`, which every server consumer imports. `isErrorResult` in
> `src/SessionView.tsx` is a separate client twin of the same rule: change one, change the
> other, or the Errors counts diverge. See [Gotchas](../contributing/gotchas.md).

### Live streaming (`server/live.ts`)

Tails an in-progress session and pushes new messages over SSE. `isLiveCandidate(filePath)`
gates on a recency window. Two watcher implementations by source: a JSONL `Watcher`
(Claude Code, Codex — size-poll + incremental read from the last offset) and a
`SqlitePollWatcher` (Cursor, OpenCode — re-parses a temp DB snapshot, WAL-aware mtime). Both
slow their poll interval after a period of silence and auto-stop when the last viewer
disconnects. Live messages use `seq` starting at 1,000,000 to avoid colliding with stored rows
and exist only in client state until re-import.

### Context causality (`server/causality.ts`)

`analyzeCausality(sessionId)` links what the AI **read** to what it **changed** via pure
structural analysis over the tool-call sequence:

| Confidence | Signal |
| --- | --- |
| 0.95 | read the exact file it then changed |
| 0.55 | read a sibling file in the same directory |
| 0.5 | read a file with the same base name |
| 0.45 | a search pattern that matches the changed file |
| 0.2 | read shortly before the change (background context, 8-read window) |

## The Insights engine

**Insights** is Chronicle's tabbed analytics surface — **Overview / Explore / Content** —
available at three scopes: all projects (the sidebar's **Insights** page), one project (a
project's own Overview/Explore/Content/Sessions tabs), and one session (drill into Content
from a session's Overview). All three scopes share the same underlying engines, parameterized
by a `Scope`:

```ts
// server/scope.ts
export type Scope = { type: 'all' | 'project' | 'session'; id?: number | string };
```

`scopeClause(scope)` turns that into a SQL `WHERE` fragment the engine queries AND onto — and
`minorGate(scope)` applies the noise-gate exclusion everywhere *except* session scope (a
directly-opened session should never disappear just because it's flagged minor; the exclusion
only matters for aggregates over many sessions).

- **`server/insights.ts`** (`GET /api/insights`) — cross-project aggregation: spend/token/session
  totals, tool and model distributions, error rate, commit counts (via `commitCountSinceAsync`,
  run concurrently across projects rather than serially), and a fixed-window activity calendar
  for the Working Rhythm panel.
- **`server/explore.ts`** (`GET /api/explore`) — the pivot table: group/subgroup by model,
  project, source, tool, skill, subagent, or hour of day, metric = spend/tokens/requests/
  sessions/errors/active-time.
- **`server/content.ts`** (`GET /api/content`) — context composition: what share of tokens are
  tool results vs. tool calls vs. user/assistant/thinking text, tool-results-by-tool, and
  skills/subagents as a share of total tokens.

### Token magnitude reconciliation and calibration

Chronicle bills tokens **per assistant API call**, not per tool-call or message kind — so
"how many tokens did tool X's output cost" isn't a number the logs record directly.
`server/calibrate.ts` is the one shared primitive that estimates it: it takes each bucket's
share of message **text length** and scales that share onto the real billed total from
`sessions.usage`, so the numbers Explore and Content show for tool/skill/subagent breakdowns
sum to the same magnitude as the session's actual token spend rather than a separately-derived
(and often wildly different) estimate. Results built this way carry a `calibrated: true` flag,
and the UI marks them with a `≈` and an explanatory tooltip — an honest signal that the
per-bucket split is an estimate even though the total it's scaled to is exact.

## HTTP API

Chronicle exposes one mount on one local port: `/api`. Requests are local only; the standalone
server binds `127.0.0.1`.

> **Reading the database directly?** There is no compatibility view layer: a reader takes the
> base tables as they are, and they may be reshaped without notice.

| Area | Routes |
| --- | --- |
| Import & scan | `GET /scan`, `POST /import`, `POST /projects/:id/sync`, `POST /sessions/:id/sync` |
| Projects | `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id`, `DELETE /projects/:id`, `POST /projects/:id/associate`, `POST /projects/:id/unlink` |
| Sessions | `GET /sessions/:id/messages`, `PATCH /sessions/:id`, `DELETE /sessions/:id`, `DELETE /sessions/:id/source-file`, `POST /sessions/undo-delete`, `GET /sessions/minor`, `POST /sessions/:id/promote`, `GET /sessions/:id/causality`, `GET /sessions/:id/live` (SSE), `GET /sessions/:id/security-check`, `GET /sessions/:id/export-redacted` |
| Git | `GET /git/at`, `GET /git/tree`, `GET /git/file` |
| Search | `GET /search` |
| Live | `GET /live/status` |
| Security | `GET/POST /security/rules`, `PATCH/DELETE /security/rules/:id` |
| Insights | `GET /insights`, `GET /explore`, `GET /content` |
| Settings | `GET/PATCH /settings`, `GET /autosync/status`, `POST /autosync/run` |

`GET /api/sessions/:id/live` is **not** JSON — it upgrades to `text/event-stream` and pushes
`data:` frames; the watcher auto-stops when the connection closes.

## Related

- [Supported tools](../reference/supported-tools.md) — the tool matrix, log locations, and
  configuration (env vars, `config.json`, ports).
- [Privacy & data](../reference/privacy-and-data.md) — the local-first guarantees and outbound
  calls (there are none).
- [Installation](../guide/installation.md) — install paths, run modes, requirements.
- [Contributing](../contributing.md) — dev setup and verification habits.
