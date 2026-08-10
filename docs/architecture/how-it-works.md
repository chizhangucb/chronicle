# How It Works

Chronicle is a local-first "time machine" for AI coding sessions: it imports conversation
logs from four tools, maps every message to the Git snapshot at that moment, and adds
security redaction, live streaming, background auto-sync, and deterministic replay — all in
a single Node process with no cloud backend and no LLM calls.

This page is the whole architecture, top to bottom: the one design decision everything else
hangs off (single process, single port), the data model, ingestion, the Git snapshot engine,
and the security/live/replay subsystems. Read it once; it's the map for the rest of the
codebase.

## Single process, single port

Chronicle is two Express apps and a React UI. The apps are:

| App | Mount | Responsibility |
| --- | --- | --- |
| `server/api.js` | `/api` | All REST routes (scan/import, projects, sessions, git, search, security, replay, feedback) |
| `server/shares.js` | `/share` | Public redacted, tokenized share pages served by the local app |

The key move: **the exact same app objects are served in every run mode.** In development
they are mounted *into* the Vite dev server; in production a plain Express server
(`server/standalone.js`) mounts them directly. Add an endpoint to one of these apps and it
works in dev, desktop, and standalone for free — no per-mode wiring.

In dev, `vite.config.js` installs a small plugin that hangs middleware off Vite's connect
server and loads each app lazily per request via `ssrLoadModule` — so **editing `server/*.js`
hot-reloads the API** without restarting the process, on the same port as the UI (`4173`).

In production there is no Vite. `server/standalone.js` builds an Express app, mounts the same
apps, and serves the built `dist/` for everything else.

> **Gotcha — mount an Express *app*, not a Router.** The Vite middleware hands the app a raw
> Node `req`/`res`. An Express *Router* does not decorate those objects, so `res.json` is
> `undefined` and every route throws. Mounting a full Express *application* is what makes the
> same code run behind Vite and behind `standalone.js`.

## Component map

```
┌──────────────────────────────────────────────────────────────┐
│  Desktop shell — Electron (electron/main.mjs)                 │
│  tray, single-instance lock, auto-update; zero server imports │
└───────────────────────────┬──────────────────────────────────┘
                            │ starts
┌───────────────────────────▼──────────────────────────────────┐
│  Server layer (Node, node:sqlite, shells out to git)          │
│                                                               │
│  parsers/      claudeCode · codex · cursor · opencode         │
│                → normalized events                            │
│  db.js         projects / sessions / messages  (SQLite)       │
│  git.js        read-only snapshot engine (rev-list/ls-tree)   │
│  live.js       JSONL tail + SQLite poll → SSE                 │
│  replay.js     deterministic sandbox re-execution             │
│  causality.js  read→change linking (heuristic)                │
│  security.js   redaction rules, session scan                  │
│  shares.js     tokenized redacted /share pages                │
│                                                               │
│  Exposed as two Express apps → /api · /share                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────────┐
│  React UI (src/) — plain React + one styles.css, no framework │
│  App.jsx global sidebar · SessionView playback/refine/replay  │
│  hand-rolled SVG charts                                       │
└──────────────────────────────────────────────────────────────┘
```

The layering is strict in one direction that matters: **the server layer has zero Electron
imports.** Electron starts the server and owns the window/tray, but nothing under `server/`
knows Electron exists.

## Run modes

All three modes serve the same apps; they differ only in what wraps them.

| Command | What runs | Port | Notes |
| --- | --- | --- | --- |
| `npm run dev` | Vite dev server + apps mounted via the plugin | `http://localhost:4173` | UI HMR **and** API hot-reload (`ssrLoadModule`) |
| `npm run desktop` | `vite build` → Electron shell + tray | `41730` | Production bundle, window hides to tray |
| `npm run standalone` | `server/standalone.js`, headless | `41730` | Binds `127.0.0.1`; `PORT` override; UI + `/api` + `/share` |

Electron runs the standalone server internally, so "desktop" and "standalone" are the same
server code with or without a window. Long-lived singletons (the live-tail watchers, auto-sync
timers) live on `globalThis` so a Vite SSR module reload doesn't orphan them.

## Product principles

1. **Local-first, offline by default.** Parsing, viewing, and managing a session require no
   network call. The only deliberate outbound features are the update check and the feedback
   relay — each opt-in and narrow.
2. **Git is the source of truth for code state.** Snapshots are reconstructed from commit
   history matched to conversation timestamps — never from a separate snapshot store, never
   from current disk.
3. **Read-only on foreign systems.** Source logs and project repos are never written. SQLite
   sources are copied to temp before opening; the git engine only reads.
4. **Safe by default.** Replay runs in a sandbox, redaction is one-way, destructive ops back
   up first and need an explicit click.
5. **Everything heavy is heuristic + local.** Causality confidence tiers, redaction regexes,
   active-duration math — all local heuristics. **No LLM calls anywhere.**

### Key stack decisions

- **`node:sqlite` (`DatabaseSync`), not better-sqlite3.** Zero native compilation, so the app
  builds and ships without a compiler on the target.
- **The git engine shells out to `git`** (`execFileSync`) rather than linking libgit2 — no
  native dependency, and it matches whatever `git` the developer already trusts.
- **Electron, not Tauri** — the dev machine has no Rust toolchain, and the zero-Electron-imports
  rule keeps the Tauri path open if the ~100 MB framework floor ever becomes worth shedding.
- **Plain React + one `styles.css`**, hand-rolled SVG/CSS charts — no UI framework, no chart
  library.
- **Dependency discipline:** only genuine server-runtime deps (`express`, `electron-updater`)
  live in `dependencies`; client libs (`react`, `react-dom`, `diff`) are `devDependencies`
  because Vite bundles them into `dist/` and electron-builder ships everything in
  `dependencies`.

## Data model

Chronicle stores everything in a single local SQLite database at `~/.chronicle/chronicle.db`
(override: `CHRONICLE_DATA_DIR`) — three tables (`projects`, `sessions`, `messages`) — and
every parser flattens its tool-native log into one normalized event shape so the UI never has
to care where a session came from.

```js
// server/db.js
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
  --                    agent_active_ms, engaged_ms
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
  -- migration columns: is_sidechain, agent_type, skill, and five per-message
  --                    token columns (input/output/cache_read/cache_w5m/cache_w1h)
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id);
```

**`projects`** is keyed on `path` — the physical `cwd` recorded in the logs. One physical
directory is one logical project no matter how many tools worked in it.

**`sessions`** carries identity and summary fields, plus migration columns added over time:
`context_tokens` (prompt side of the last main-chain API call, only set on import — re-import
or Sync Update to backfill), `name` (a user-typed rename in Chronicle — the only user-authored
field in the table), `summary` (parsed tool title, re-derived every import), `usage` (per-model
token totals as JSON, shaped `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`
— 5-minute and 1-hour cache writes are kept split because they bill at different rates),
`sidechain_count` (a denormalization for cards/analytics), and the stored duration metrics
`agent_active_ms` / `engaged_ms` (computed at import time so the UI reads one number instead of
re-deriving it client-side).

**`messages`** is the normalized event stream, ordered by `seq` within a session. The
`(session_id, seq)` index is what makes windowed playback cheap — the UI renders ~400 rows
around the selection rather than loading a 6,000-message session into the DOM. `is_sidechain`
(1 = subagent/sidechain event — Claude Code only), `agent_type` (subagent type, matched by
pairing the sidechain's first message with the main chain's `Task` tool call), and `skill`
(active skill context) support subagent attribution. Five per-message token columns
(`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_w5m_tokens`, `cache_w1h_tokens`)
are stored on the first event of each API call, which is what unlocks costliest-message
rankings — `sessions.usage` alone can't answer those. **The database stores tokens, never
dollars**; `src/models.js` computes cost client-side from a static price table.

### The normalized event model

Every parser's job is to turn a tool-native log into a flat list of rows of one shape — the
contract between ingestion and everything downstream (playback, refine, causality, search,
share).

| `kind` | Meaning | Label (`src/kinds.js`) |
| --- | --- | --- |
| `user` | a human prompt or an inserted user turn | User |
| `assistant` | model prose | Assistant |
| `thinking` | extended-thinking block | Thinking |
| `tool_use` | a tool call (has `tool_name`, `tool_input`, `tool_use_id`) | Tool Call |
| `tool_result` | a tool's output (has `tool_use_id`) | Tool Result |
| `note` | a Refine-inserted annotation | Inserted |

Each event row populates a subset of: `ts`, `kind`, `text`, `tool_name`, `tool_input` (a JSON
*string*), `tool_use_id`, `uuid`, `model`. `tool_use_id` is the join key: a `tool_use` and the
`tool_result` it produced carry the same id.

> **One source of truth for labels.** `src/kinds.js` (`KIND_LABEL` / `KIND_ICON`) is imported
> by both Playback and Refine, so the vocabulary can't drift. Put new wording there, never
> inline.

### `replaceSession()` — idempotent import

Import is not an upsert-per-row; it is a full **delete-and-reinsert of one session inside a
transaction**. Re-importing the same log produces the same rows, so Sync Update and re-import
are safe to run repeatedly:

```js
// server/db.js — abridged
export function replaceSession(session, events) {
  db.exec('BEGIN');
  try {
    const prev = db.prepare('SELECT name FROM sessions WHERE id = ?').get(session.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.prepare(`INSERT INTO sessions (..., name, summary, usage) VALUES (..., ?, ?, ?)`)
      .run(/* … */ session.name ?? prev?.name ?? null, session.summary ?? null, session.usage ?? null);
    events.forEach((e, i) => ins.run(session.id, i, /* … */));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
```

The subtle part: because the row is about to be deleted, a naive reinsert would wipe any
rename the user typed. So `replaceSession` **reads `prev.name` first and falls back to it**.
Result: `name` survives re-import (it's user-authored); `summary`/`usage`/`context_tokens` are
re-derived every import, since they come from the log and the freshest parse should win.

### FTS5 full-text index

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```

An external-content FTS5 table over `messages.text` and `tool_input`, populated inside
`replaceSession` — because import is a delete-and-reinsert, rebuilding the session's FTS rows
in the same transaction keeps the index consistent without triggers. `GET /api/search` uses
FTS5 `MATCH` and falls back to `LIKE` if the FTS table is missing, grouped per session (empty
query → recent sessions).

### Contract views

Two read-only SQL views expose a **metrics-only** surface (no message text, no tool input) for
external consumers, so base tables stay free to refactor:

```sql
CREATE VIEW contract_message_metrics AS
SELECT m.session_id, m.seq, m.ts, m.kind, m.model,
       m.is_sidechain, m.agent_type, m.skill, m.tool_name,
       m.input_tokens, m.output_tokens, m.cache_read_tokens,
       m.cache_w5m_tokens, m.cache_w1h_tokens, s.file_path AS source_file
FROM messages m JOIN sessions s ON s.id = m.session_id;

CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage, s.agent_active_ms, s.engaged_ms
FROM sessions s JOIN projects p ON p.id = s.project_id;
```

`PRAGMA user_version = 1` is set at migration and bumped only on breaking view changes — a
consumer should refuse loudly on `0` or an unknown value rather than guess at the shape.

## Ingestion: scan, then import

Every parser lives in `server/parsers/<tool>.js` and exports two kinds of function:

- **`scan<Tool>Projects()`** — cheap, read-only. Lists importable projects/sessions with size
  estimates, without parsing message bodies. Backs the import wizard.
- **A parse function** — reads a session's native log and returns `{ session, events }`.

The four parsers wired in today:

| Tool | Source key | File / dir (env override) | Format |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` (`CLAUDE_PROJECTS_DIR`) | JSONL |
| Codex | `codex` | `~/.codex/sessions/` (`CODEX_SESSIONS_DIR`) | JSONL |
| Cursor | `cursor` | VS Code `workspaceStorage` (`CHRONICLE_CURSOR_DIR`) | SQLite (WAL) |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`) | SQLite (WAL) |

`GET /api/scan` fans out to all four scanners and annotates which sessions are already
imported; `POST /api/import` routes the chosen source through `gatherParsed()` to the right
parse function, then hands each `{ session, events }` to `replaceSession()`. The same
`scanners` map backs a manual "select directory" scan and per-project/per-session sync.

> **Read-only, always.** Scanning and importing only read source logs. The write side of
> ingestion touches nothing but `~/.chronicle/chronicle.db`.

### Per-tool notes

**Claude Code JSONL — filter the noise.** `parseClaudeLine()` skips `isSidechain` entries into
a separate attribution path (see below), skips `<command-name>`/`<local-command…>` user
strings and `<system-reminder>` text blocks (not real prompts), and pairs `tool_use`/
`tool_result` by `tool_use_id`. The session's auto-title comes from
`{"type":"custom-title","customTitle":…}` lines — the `/rename` title, last one wins.

**Sidechain (subagent) attribution — Claude Code only.** The parser imports sidechain lines
(rather than dropping them) and marks them `is_sidechain = 1`, then derives `agent_type` by
pairing the sidechain's first user message with the main chain's `Task` tool-call input
(`subagent_type`). `skill` is set on a `Skill` tool-call row and on `<command-name>` turns.
Span-style "everything between invocation and next user turn" attribution is deliberately not
attempted — too heuristic. Scope rule: `context_tokens` stays main-chain-only (matching Claude
Code's own status line); Cost & Usage and Agent Active *include* sidechains; default message
counts, playback, and refine *exclude* them.

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

1. **Write `server/parsers/newtool.js`** exporting `scanNewtoolProjects()` (cheap listing) and
   a parse function returning `{ session, events }` where each event is a normalized row
   (`{ ts, kind, text?, tool_name?, tool_input?, tool_use_id?, uuid?, model? }`). Populate
   `cwd` on the session; if the source is a WAL SQLite DB, copy the `-wal`/`-shm` sidecars to
   temp exactly as Cursor/OpenCode do.
2. **Wire it into `server/api.js`** — import the two functions, add it to the `scanners` map
   and `GET /scan`, and add a branch to `gatherParsed()` so `POST /import` routes to it.
3. **Add it to `SOURCES` in `src/ImportWizard.jsx`** with a matching `key`.
4. **Validate against a fixture, then real data.** Drop a sample log in `test/fixtures/` and
   confirm scan lists it and import produces sane rows; then import a real session and
   time-travel through it.

## Git snapshot engine

Time travel works because Chronicle treats **Git history as the source of truth for code
state**. `server/git.js` reconstructs "what the code looked like at this message" by matching
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
project-card git pill (branch + commit count) is always live and accurate. If it shows a
feature branch after a PR merged, the pill is right and the working tree is still on that
branch.

**`commitAt()` picks the nearest commit at or before the timestamp**, with a fallback: when a
message predates the repo's first commit, there's nothing at-or-before it, so the engine falls
back to the **oldest** commit and sets `beforeHistory: true`.

The time-travel data flow: select a message → `commitAt(dir, ts)` → the nearest commit →
`treeAt()` (file tree) and `fileAt()` (content + previous version for diff). The API exposes
this as `GET /api/git/at`, `GET /api/git/tree`, `GET /api/git/file`. Because state is always
reconstructed from history, **fidelity tracks commit frequency** — uncommitted work between two
commits is invisible to the engine.

**Merge commits are the one place naive `diff-tree` lies** — against a merge, `diff-tree` with
default options produces an *empty* diff. Both `fileAt()` and `changedFiles()` pass `-m
--first-parent` so the diff is computed against the mainline before the merge.

## Security, live streaming, replay & causality

Four subsystems make Chronicle feel "smart" — secret redaction, live session tailing,
deterministic replay, and read→change causality — and all four are **local heuristics**, no
LLM calls.

### Security engine (`server/security.js`)

Turns text into `{ findings, redacted }`. Built-in regex detectors (`api_key`, `password`,
`token`, `db_conn`, `email`, `phone`, `private_ip`) run in an order that matters — `db_conn`
before `email`/`password` so a connection string redacts as a whole rather than getting
shredded into separate matches. Custom rules are **globs** (`*`/`?`) compiled to regex, either
a `redact` rule or an `allow` rule that protects a span. `scanText()` resolves overlaps by
priority: allow-list wins first, then custom rules before built-ins, then earlier match wins on
overlap. `scanSession(messages)` is the batch path used by Security Check and share creation.

> **Contributor gotcha.** The "is this tool result an error?" check exists in two places —
> `ERROR_RE` in `server/api.js` and `isErrorResult` in `src/SessionView.jsx`. Change one, change
> both, or the Errors counts diverge.

### Live streaming (`server/live.js`)

Tails an in-progress session and pushes new messages over SSE. `isLiveCandidate(filePath)`
gates on a 5-minute recency window. Two watcher implementations by source: a JSONL `Watcher`
(Claude Code, Codex — size-poll + incremental read from the last offset) and a
`SqlitePollWatcher` (Cursor, OpenCode — re-parses a temp DB snapshot, WAL-aware mtime). Both
slow their poll interval after ~2 minutes of silence and auto-stop when the last viewer
disconnects. Watchers live on `globalThis.__chronicleLive`; live messages use `seq` starting at
1,000,000 to avoid colliding with stored rows and exist only in client state until re-import.

### Replay engine (`server/replay.js`)

Re-executes a session's file and shell operations in an isolated sandbox
(`~/.chronicle/replay/<id>/`) — deterministic, no LLM calls, never touching the real project.
`buildPlan(sessionId)` extracts `Write`/`Edit`/`Bash` steps with the preceding assistant text as
`reasoning`, flagging out-of-project targets. `startReplay()` seeds the sandbox from the Git
snapshot at session start (`commitAt()` + `git archive | tar -x`). `executeStep()` applies
Write/Edit directly to the sandbox; Bash requires an explicit `confirmCommand` (60s timeout,
sandboxed cwd/HOME) or returns `{ needsConfirmation: true }` without running anything.
Auto-play pauses on errors and **skips** (never hard-pauses on) command steps and out-of-project
writes.

### Context causality (`server/causality.js`)

`analyzeCausality(sessionId)` links what the AI **read** to what it **changed** via pure
structural analysis over the tool-call sequence:

| Confidence | Signal |
| --- | --- |
| 0.95 | read the exact file it then changed |
| 0.55 | read a sibling file in the same directory |
| 0.5 | read a file with the same base name |
| 0.45 | a search pattern that matches the changed file |
| 0.2 | read shortly before the change (background context, 8-read window) |

### Share links (`server/shares.js`)

Sharing serves a session as a tokenized HTML page from the **local app** — nothing is uploaded.
`createShare(sessionId, days = 7)` runs `scanSession()` and stores only the **redacted copy**,
frozen at creation, so a later rule change can't retroactively leak anything. `listShares()` /
`revokeShare(id)` manage tokens; the public page 404s once expired or revoked.

## Desktop shell, packaging & auto-update

The desktop app is an Electron shell (`electron/main.mjs`) around the same headless server
that runs in dev and standalone mode. Electron is a **thin shell**: it starts the server, owns
a window and tray, and does auto-update — nothing under `server/` imports Electron.

On launch: acquire the single-instance lock (also holds port `41730` — a stale process holding
either is the usual cause of "new build won't start"), start the embedded server
(`server/standalone.js`), build the tray, show the window. **Closing the window hides it to the
tray** rather than quitting, so auto-sync (fs-watchers, the 30-minute backstop, wake-resume)
keeps running with no window open; only the tray's Quit item actually exits.

Auto-update runs via `electron-updater`, feed = `build.publish` (github
`chizhangucb/homebrew-chronicle`), baked into `app-update.yml` at build time. It checks on
launch and every 6 hours (packaged only), downloads in the background, and the React UI shows
a "Relaunch to update" toast (bridged over IPC via `electron/preload.cjs`) on
`update-downloaded`; `quitAndInstall()` does the clean swap. Two hard requirements: the
`package.json` version must equal the release tag, and the update installs **only when the
running app and the update share a Developer ID signature** — dormant until the first signed
release, and unspoofable by an untrusted build.

Packaging is `electron-builder`, `asar: false` (the server resolves `dist/` and parsers as
plain files via `import.meta.url`; asar packing breaks that). `mac.target` is `dmg` + `zip` —
the zip is what electron-updater updates from. `build/notarize.cjs` notarizes only when
`APPLE_*` credentials are in env, so `npm run dist:mac` stays green for a contributor with no
Apple account. Only genuine server-runtime deps (`express`, `electron-updater`) live in
`dependencies`; everything client-side is a `devDependency`.

The Homebrew cask (`packaging/homebrew/`) is published to the public
`chizhangucb/homebrew-chronicle` tap, which also hosts the release DMGs and serves as the
update feed:

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

## HTTP API

Chronicle exposes two mounts on one local port: `/api` (the REST API) and `/share` (public
redacted pages) — the same Express apps back all three run modes. Requests are local only; the
standalone server binds `127.0.0.1`.

> **Reading the database directly?** External consumers should read the versioned
> `contract_*` SQL views (above) rather than these routes.

| Area | Routes |
| --- | --- |
| Import & scan | `GET /scan`, `POST /import` |
| Projects | `GET /projects`, `GET /projects/:id?days=N`, `PATCH /projects/:id`, `DELETE /projects/:id`, `POST /projects/:id/associate`, `POST /projects/:id/sync`, `POST /projects/:id/unlink` |
| Sessions | `GET /sessions/:id/messages`, `PATCH /sessions/:id`, `DELETE /sessions/:id`, `DELETE /sessions/:id/source-file`, `POST /sessions/:id/sync`, `GET /sessions/:id/causality`, `GET /sessions/:id/live` (SSE), `GET /sessions/:id/security-check`, `GET /sessions/:id/export-redacted`, `POST /sessions/:id/share`, `GET /sessions/:id/replay-plan` |
| Git | `GET /git/at`, `GET /git/tree`, `GET /git/file` |
| Search | `GET /search` |
| Live | `GET /live/status` |
| Security | `GET/POST /security/rules`, `PATCH/DELETE /security/rules/:id` |
| Replay | `GET /replay/preview`, `POST /replay/start`, `POST /replay/step`, `POST /replay/open` |
| Feedback | `POST /feedback` |
| Shares | `GET /shares`, `DELETE /shares/:id`, and on `/share`: `GET /share/:token` |

`GET /api/sessions/:id/live` is **not** JSON — it upgrades to `text/event-stream` and pushes
`data:` frames (`{ type: 'status' | 'messages', ... }`); the watcher auto-stops when the
connection closes.

## Related

- [Supported tools](../reference/supported-tools.md) — the tool matrix, log locations, and
  configuration (env vars, `config.json`, ports).
- [Privacy & data](../reference/privacy-and-data.md) — the local-first guarantees and outbound
  calls.
- [Installation](../guide/installation.md) — install paths, run modes, requirements.
- [Contributing](../contributing.md) — dev setup and verification habits.
