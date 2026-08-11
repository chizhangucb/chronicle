# Supported Tools & Configuration

Which AI coding tools Chronicle imports from, where each tool's logs live on disk, and the
handful of environment variables you can use to override the defaults.

Chronicle imports conversation logs from four tools and maps every message to the Git snapshot
at that moment. Most features work identically across all four; subagent (sidechain)
attribution is Claude Code-specific, and remote access is not built yet.

## Feature support matrix

| Feature | Claude Code | Codex | Cursor | OpenCode |
| --- | :---: | :---: | :---: | :---: |
| Conversation import | ✅ | ✅ | ✅ | ✅ |
| Time Travel / code snapshots | ✅ | ✅ | ✅ | ✅ |
| Refine mode | ✅ | ✅ | ✅ | ✅ |
| Message filtering | ✅ | ✅ | ✅ | ✅ |
| Content redaction | ✅ | ✅ | ✅ | ✅ |
| Tool call viewing | ✅ | ✅ | ✅ | ✅ |
| Context Causality | ✅ | ✅ | ✅ | ✅ |
| Git history matching | ✅ | ✅ | ✅ | ✅ |
| Live streaming | ✅ | ✅ | ✅ | ✅ |
| Auto-sync | ✅ | ✅ | ✅ | ✅ |
| Insights (Overview / Explore / Content) | ✅ | ✅ | ✅ | ✅ |
| Subagent (sidechain) import | ✅ | – | – | – |
| Per-message token usage | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Remote SSH access | 🔜 | 🔜 | 🔜 | 🔜 |

Legend: ✅ full · ⚠️ partial · 🔜 planned (not yet built) · – not applicable.

- **Subagent (sidechain) import** — with `agent_type` and skill attribution, surfaced in the
  session Overview's Subagents card and in Insights' Explore/Content tabs — is a Claude Code
  concept; the other parsers mark every row as not a subagent.
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
`OPENCODE_DB` in `server/parsers/*.ts`). Only Cursor exposes an environment override.

### Per-tool caveats

- **Cursor and OpenCode share one database across sessions.** Because one file backs many
  sessions, per-session source-file deletion is disabled for these tools (it's offered only
  for one-file-per-session sources: Claude Code, Codex).

## Known limitations

- **Large sessions degrade gracefully.** Beyond a few thousand messages, the UI switches to
  windowed rendering — it draws roughly a few hundred DOM rows around your current position
  and decimates timeline ticks — so a long session stays responsive.
- **Git submodules** are supported by the snapshot engine.
- **Non-standard or custom log paths** are handled through the `CHRONICLE_CURSOR_DIR`
  override for Cursor; the other three sources read from their tool's single well-known
  location.

## Configuration

Chronicle needs almost no configuration — it works out of the box against your tools' default
log locations and stores everything under a single directory in your home folder. There is no
settings server and no account; overrides are environment variables and a local config file.

### The `~/.chronicle/` directory

Everything Chronicle writes lives under one base directory (`~/.chronicle` by default; see
`CHRONICLE_DATA_DIR` below), created idempotently on first run.

| Path | What it holds |
| --- | --- |
| `chronicle.db` | The SQLite database — all projects, sessions, and messages |
| `backups/` | Backups written before destructive operations (e.g. deleting a project) |
| `config.json` | Local settings — auto-sync on/off, pause state, the noise-gate thresholds |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHRONICLE_DATA_DIR` | `~/.chronicle` | Base directory for the database and all state above |
| `CHRONICLE_CURSOR_DIR` | Cursor's VS Code `workspaceStorage` | Point the Cursor parser at a non-standard location |
| `PORT` | `41730` | Requested port (the CLI's `--port` flag does the same thing) |

### Auto-sync settings

The in-app **Settings** panel (bottom of the sidebar) toggles background auto-sync on/off and
lets you pause it without tearing down its file watchers. These are stored in
`~/.chronicle/config.json` and read back via `GET /api/settings`; see
[How it works](../architecture/how-it-works.md) for what auto-sync actually does under the
hood (watchers, debounce, backstop).

### Ports and binding

```bash
npx chronicle-cli --port 5173
```

Chronicle binds to `127.0.0.1` (loopback only — it's never reachable from another machine on
your network) and requests port `41730` by default. If that port is taken, it scans forward
for a free one and prints the port it actually bound.

## Related

- [Installation](../guide/installation.md) — the `npx chronicle-cli` install path, CLI flags,
  and requirements.
- [Privacy & data](./privacy-and-data.md) — exactly what is stored locally and the outbound
  network calls (there are none).
- [How it works](../architecture/how-it-works.md) — the ingestion pipeline and the invisible
  sync engine.
