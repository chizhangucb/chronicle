# Parsers & Ingestion

Ingestion turns six different tools' native logs into one normalized event stream. It runs in two phases — **scan** (list what's importable) and **import** (parse the chosen logs and write them) — and it never writes to a source log or project repo.

This page explains the scan → import pipeline, the per-tool quirks each parser hides (SQLite WAL copies, cwd resolution, Claude Code's noise filters), and a concrete walkthrough for adding a seventh source. If you want the row shape these parsers emit, read [Data model](data-model.md) first.

## The pipeline: scan, then import

Every parser lives in `server/parsers/<tool>.js` and exports the same two kinds of function:

- **`scan<Tool>Projects()`** — cheap, read-only. Lists importable projects and their sessions with size estimates, without parsing message bodies. It's what the import wizard renders.
- **A parse function** — reads a session's native log and returns `{ session, events }`, where `events` is the normalized rows described in [Data model](data-model.md).

The six parsers wired in today:

| Tool | Source key | File / dir (env override) | Format | Scan / parse exports |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` (`CLAUDE_PROJECTS_DIR`) | JSONL | `scanClaudeProjects()`, `parseClaudeSession()` (+ `parseClaudeLine()`) |
| Codex | `codex` | `~/.codex/sessions/` (`CODEX_SESSIONS_DIR`) | JSONL | `scanCodexProjects()`, `parseCodexSession()` |
| Cursor | `cursor` | workspaceStorage (`cursorUserDir()`, `CHRONICLE_CURSOR_DIR`) | SQLite | `scanCursorProjects()`, `parseCursorWorkspace()` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`) | SQLite | `scanOpencodeProjects()`, `parseOpencodeSessions()` |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` (`GEMINI_TMP`) | JSON | `scanGeminiProjects()`, `parseGeminiProject()` |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/` (`vscodeUserDirs()`, `CHRONICLE_VSCODE_DIR`) | JSON | `scanCopilotProjects()`, `parseCopilotWorkspace()` |

`server/api.js` fans out to all six. `GET /api/scan` calls each `scan…Projects()` and annotates which projects/sessions are already imported; `POST /api/import` routes the chosen source through `gatherParsed()` to the right parse function, then hands each `{ session, events }` to `replaceSession()`:

```js
// server/api.js — scan fans out to every source
api.get('/scan', (req, res) => {
  res.json({
    'claude-code': annotateScan(scanClaudeProjects()),
    codex:         annotateScan(scanCodexProjects()),
    cursor:        annotateScan(scanCursorProjects()),
    opencode:      annotateScan(scanOpencodeProjects()),
    'gemini-cli':  annotateScan(scanGeminiProjects()),
    'copilot-chat':annotateScan(scanCopilotProjects()),
  });
});
```

The same `scanners` map also backs a manual "select directory" scan (pass `?source=&dir=`), and `POST /api/projects/:id/sync` reuses it to re-import every source location that maps to a project's path.

> **Read-only, always.** Scanning and importing only read source logs. The write side of ingestion touches nothing but Chronicle's own `~/.chronicle/chronicle.db`.

## Per-tool notes

The normalized model hides real differences between tools. The interesting engineering is in the parsers.

### Claude Code JSONL — filter the noise

`parseClaudeLine()` in `server/parsers/claudeCode.js` is deliberately picky, because a raw import would fill with machine chatter:

- **Skip `isSidechain` entries.** Sub-agent turns are a separate context; including them pollutes the main thread.
- **Skip `<command-name>` / `<local-command…>` user strings** — slash-command scaffolding, not real prompts.
- **Skip `<system-reminder>` text blocks** — injected context, not conversation.
- **`tool_use` / `tool_result` pair by id.** A `tool_result` block carries `tool_use_id`, matched to the `tool_use` that made the call.

The session's auto-title comes from `{"type":"custom-title","customTitle":…}` lines — the `/rename` title, and the **last one wins** (a session can be renamed repeatedly). That becomes `sessions.summary`. There are effectively no `type:"summary"` lines in real logs, so `custom-title` is the only auto-title source (a legacy `summary` line is kept only as a fallback). The same parse pass also aggregates per-model token usage and the real `context_tokens` from `message.usage`.

### Cursor & OpenCode — copy the WAL, never open live

Both store chats in SQLite databases that the running editor may still be writing. Chronicle copies the DB to a temp directory **including the `-wal` and `-shm` sidecar files** before opening it read-only:

```js
// server/parsers/opencode.js — copy sidecars or you get an EMPTY database
fs.copyFileSync(dbPath, copy);
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
}
```

The subtle bug this avoids: in WAL mode the newest writes live in the `-wal` file, not the `.db`. Copy only the `.db` and you open a snapshot that's missing recent (sometimes all) rows. Copying the sidecars gives a consistent point-in-time read without ever touching — or locking — the live database.

### Gemini CLI — virtual paths and "Needs association"

Gemini's logs don't record a working directory, so there's no physical `cwd` to key a project on. `scanGeminiProjects()` assigns a virtual path `gemini-project:<hash>` and flags the project `needsAssociation: true`. The UI surfaces a **"Needs association"** banner; associating it (`POST /api/projects/:id/associate`) merges the virtual project into the real one on path match, so its sessions land alongside the other tools' work in the same directory.

### cwd resolution — latest wins, collapse to an ancestor

Logical projects key on the physical `cwd` in the logs, but a single session can record several. Two rules reconcile them:

- **Latest `cwd` wins.** A session resumed after a repo move keeps the *old* path in its early records; the newest cwd is where the repo (and its Git history) lives now. The scanner sniffs both the **head and tail 64 KB** of each JSONL file to find it cheaply, and the parser tracks the last seen cwd.
- **`reduceCwd()` collapses subdirectories.** If a session logged `<repo>/server` and also `<repo>`, grouping should land on the repo root. `reduceCwd(pick, seen)` walks up to the shortest seen ancestor so all a project's sessions group together.

## HOWTO: add a new source

Adding a seventh tool is a self-contained, four-step change. Say you're adding a tool called `newtool`.

**1. Write `server/parsers/newtool.js`.** Export two functions:

```js
// scan<Tool>Projects() — cheap listing for the import wizard
export function scanNewtoolProjects(baseDir = NEWTOOL_DIR) {
  // return [{ source: 'newtool', name, physicalPath, sessionCount,
  //           messageEstimate, sessions: [{ id, file, label, modifiedAt, messageEstimate }] }]
}

// parse fn → { session, events } where each event is a normalized row:
//   { ts, kind, text?, tool_name?, tool_input?, tool_use_id?, uuid?, model? }
// kind ∈ user | assistant | thinking | tool_use | tool_result
export async function parseNewtoolSession(file) {
  return {
    session: { id, source: 'newtool', file_path: file, cwd,
               started_at, ended_at, first_prompt, summary, context_tokens, usage },
    events,
  };
}
```

Populate `cwd` on the session so it keys to a physical project (or return a virtual `newtool-project:<hash>` path and set `needsAssociation` like Gemini). If your source is a WAL SQLite DB, copy the `-wal`/`-shm` sidecars to temp exactly as Cursor/OpenCode do — never open the live file.

**2. Wire it into `server/api.js`.** Import the two functions, add `newtool` to the `scanners` map and the `GET /scan` response, and add a branch to `gatherParsed()` so `POST /import` routes to your parse function. (Adding it to the `sync` and per-session sync maps gets Sync Update for free.)

**3. Add it to `SOURCES` in `src/ImportWizard.jsx`** so it shows up as a tile in the wizard:

```js
{ key: 'newtool', label: 'New Tool', hint: '~/.newtool/…', icon: '◆' }
```

The `key` must match the source key you used in `/api/scan`.

**4. Validate against a fixture, then real data.** Drop a small sample log in `test/fixtures/` (the repo already has `codex-sessions/`, `cursor-user/`, `gemini-tmp/`, `oc-live.db`, `vscode-user/`) and confirm scan lists it and import produces sane normalized rows. Then run it end-to-end: import a real session, open it, and time-travel through it. The fastest full check is importing Chronicle's own Claude Code session and clicking around.

That's the whole surface. Because every mode serves the same Express apps, a parser wired into `/api/scan` and `/api/import` works in dev, desktop, and standalone with no extra plumbing.

## Related
- [Data model](data-model.md) — the normalized event rows and `kind` labels your parser must emit.
- [Compatibility](../reference/compatibility.md) — the full six-tool matrix and log locations.
- [Contributing](../contributing.md) — setup, workflow, and verification habits.
