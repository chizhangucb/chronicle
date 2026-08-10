# Supported Tools & Configuration

Which AI coding tools Chronicle imports from, where each tool's logs live on disk, and the
handful of environment variables and files you can use to override the defaults.

Chronicle imports conversation logs from four tools and maps every message to the Git snapshot
at that moment. Most features work identically across all four; subagent (sidechain)
attribution is Claude Code-specific, and remote access is not built yet.

## Feature support matrix

| Feature | Claude Code | Codex | Cursor | OpenCode |
| --- | :---: | :---: | :---: | :---: |
| Conversation import | ✅ | ✅ | ✅ | ✅ |
| Time Travel / code snapshots | ✅ | ✅ | ✅ | ✅ |
| Replay Mode | ✅ | ✅ | ✅ | ✅ |
| Message filtering | ✅ | ✅ | ✅ | ✅ |
| Content redaction | ✅ | ✅ | ✅ | ✅ |
| Tool call viewing | ✅ | ✅ | ✅ | ✅ |
| Context Causality | ✅ | ✅ | ✅ | ✅ |
| Git history matching | ✅ | ✅ | ✅ | ✅ |
| Live streaming | ✅ | ✅ | ✅ | ✅ |
| Auto-sync | ✅ | ✅ | ✅ | ✅ |
| Sidechain (subagent) import | ✅ | – | – | – |
| Per-message token usage | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Remote SSH access | 🔜 | 🔜 | 🔜 | 🔜 |

Legend: ✅ full · ⚠️ partial · 🔜 planned (not yet built) · – not applicable.

- **Sidechain (subagent) import** — with `agent_type` and `skill` attribution — is a Claude
  Code concept; the other parsers mark every row `is_sidechain = 0`.
- **Per-message token usage** is captured wherever a tool's logs carry usage records; coverage
  varies by tool and log version.
- **Remote SSH access** (import / browse / live-watch over SSH) is **planned but not
  implemented** for any tool. Everything Chronicle does today runs against local files.

## Log locations

Each parser reads its tool's native logs from a well-known path. Chronicle never writes to
these — see the read-only column.

| Tool | Source key | Path | Format | Read-only handling |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` | JSONL | Read in place; originals never modified |
| Codex | `codex` | `~/.codex/sessions/` | JSONL | Read in place; originals never modified |
| Cursor | `cursor` | VS Code `workspaceStorage` state DBs (`CHRONICLE_CURSOR_DIR` override) | SQLite (WAL) | Copied to temp **including `-wal`/`-shm`** before opening |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | SQLite (WAL) | Copied to temp **including `-wal`/`-shm`** before opening |

> **Read-only, always:** SQLite-backed sources (Cursor, OpenCode) are WAL databases. Copying
> only the `.db` file yields an *empty* database — recent writes live in the `-wal` sidecar —
> so the parsers copy the `-wal` and `-shm` files to a temp location and open the copy. Your
> tools' live databases are never touched.

Default path constants live in each parser (`CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`,
`OPENCODE_DB` in `server/parsers/*.js`). Only Cursor exposes an environment override.

### Per-tool caveats

- **Cursor and OpenCode share one database across sessions.** Because one file backs many
  sessions, per-session source-file deletion is disabled for these tools (it's offered only
  for one-file-per-session sources: Claude Code, Codex).

## Known limitations

- **Large sessions degrade gracefully.** Beyond ~5,000 messages, the UI switches to windowed
  rendering — it draws roughly 400 DOM rows around your current position and decimates
  timeline ticks — so a 6,000-message session stays responsive.
- **Git submodules** are supported by the snapshot engine.
- **Non-standard or custom log paths** are handled through manual selection: use the import
  wizard's Browse option (or the `CHRONICLE_CURSOR_DIR` override) to point Chronicle at logs
  outside the default locations.

## Configuration

Chronicle needs almost no configuration — it works out of the box against your tools' default
log locations and stores everything under a single directory in your home folder. There is no
settings server and no account; overrides are files and env vars only.

### The `~/.chronicle/` directory

Everything Chronicle writes lives under one base directory (`~/.chronicle` by default; see
`CHRONICLE_DATA_DIR` below), created idempotently on first run.

| Path | What it holds |
| --- | --- |
| `chronicle.db` | The SQLite database — all projects, sessions, and messages |
| `replay/<id>/` | Per-run Replay sandboxes, seeded from the Git snapshot at session start |
| `backups/` | Backups written before destructive or user-visible operations |
| `feedback.log` | Every feedback submission, appended locally *before* any network send |
| `config.json` | Optional user overrides (see below) |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHRONICLE_DATA_DIR` | `~/.chronicle` | Base directory for the database and all state above |
| `CHRONICLE_FEEDBACK_RELAY` | `relay.getchronicle.dev` | Override the hosted feedback relay URL |
| `CHRONICLE_CURSOR_DIR` | Cursor's VS Code `workspaceStorage` | Point the Cursor parser at a non-standard location |
| `PORT` | `41730` | Port for the headless standalone server |

### `config.json` overrides

Drop a `config.json` in the data directory to set persistent overrides without environment
variables. Today the one supported key is the feedback relay:

```json
{
  "feedbackRelay": "https://relay.example.com/feedback"
}
```

Precedence for the relay URL is: `CHRONICLE_FEEDBACK_RELAY` env → `feedbackRelay` in
`config.json` → the built-in default. Feedback always appends to `feedback.log` locally first,
so nothing is lost if the relay is unreachable.

### Ports and binding

All three run modes serve the same Express apps (`/api`, `/share`); they differ only in port
and shell.

| Mode | Port | Bind |
| --- | --- | --- |
| `npm run dev` | `http://localhost:4173` | localhost |
| `npm run desktop` (Electron) | `41730` | loopback |
| `npm run standalone` | `41730` (override with `PORT`) | `127.0.0.1` |

> **Single-instance lock:** only one Chronicle can run per machine. The Electron shell takes a
> single-instance lock and holds port `41730`, so a second launch exits silently rather than
> double-binding. If the UI 404s unexpectedly, a stale server may be holding the port — check
> `lsof -iTCP:41730`.

## Related

- [Installation](../guide/installation.md) — install paths, run modes, and requirements.
- [Privacy & data](./privacy-and-data.md) — exactly what is stored locally and the short list
  of outbound calls.
- [How it works](../architecture/how-it-works.md) — the ingestion pipeline and why one process
  serves every mode.
