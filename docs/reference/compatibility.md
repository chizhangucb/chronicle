# Compatibility

Which AI coding tools Chronicle supports, what each feature does per tool, and where each tool's logs live on disk.

Chronicle imports conversation logs from six tools and maps every message to the Git snapshot at that moment. Most features work identically across all six; subagent (sidechain) attribution is Claude Code-specific, and remote access is not built yet. Everything below reflects what ships in v0.2.0 — read the source key against `server/parsers/<tool>.js` if you need to go deeper.

## Feature support matrix

| Feature | Claude Code | Codex | Cursor | OpenCode | Gemini CLI | Copilot Chat |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Conversation import | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Time Travel / code snapshots | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Replay Mode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Message filtering | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Content redaction | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool call viewing | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Context Causality | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git history matching | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Live streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-sync | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sidechain (subagent) import | ✅ | – | – | – | – | – |
| Per-message token usage | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Remote SSH access | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |

Legend: ✅ full · ⚠️ partial · 🔜 planned (not yet built) · – not applicable.

- **Tool call viewing** is partial for Gemini CLI — its logs record tool activity less completely than the JSONL-based tools.
- **Sidechain (subagent) import** — with `agent_type` and `skill` attribution — is a Claude Code concept; the other parsers mark every row `is_sidechain = 0`.
- **Per-message token usage** is captured wherever a tool's logs carry usage records; coverage varies by tool and log version. See [Metrics & contract views](../architecture/metrics-and-contract.md).
- **Remote SSH access** (import / browse / live-watch over SSH) is **planned but not implemented** for any tool. Everything Chronicle does today runs against local files.

## Log locations

Each parser reads its tool's native logs from a well-known path. Chronicle never writes to these — see the read-only column.

| Tool | Source key | Path | Format | Read-only handling |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` | JSONL | Read in place; originals never modified |
| Codex | `codex` | `~/.codex/sessions/` | JSONL | Read in place; originals never modified |
| Cursor | `cursor` | VS Code `workspaceStorage` state DBs (`CHRONICLE_CURSOR_DIR` override) | SQLite (WAL) | Copied to temp **including `-wal`/`-shm`** before opening |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | SQLite (WAL) | Copied to temp **including `-wal`/`-shm`** before opening |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` | JSON | Read in place; originals never modified |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/` (`CHRONICLE_VSCODE_DIR` override) | JSON | Read in place; originals never modified |

> **Read-only, always:** SQLite-backed sources (Cursor, OpenCode) are WAL databases. Copying only the `.db` file yields an *empty* database — recent writes live in the `-wal` sidecar — so the parsers copy the `-wal` and `-shm` files to a temp location and open the copy. Your tools' live databases are never touched.

Default path constants live in each parser (`CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, `OPENCODE_DB`, `GEMINI_TMP` in `server/parsers/*.js`). Only Cursor and Copilot expose environment overrides — see [Configuration](./configuration.md).

### Per-tool caveats

- **Gemini CLI records no working directory.** Because there is no `cwd` in the logs, Chronicle assigns a virtual path (`gemini-project:<hash>`) and shows a **"Needs association"** banner. Point it at the real project once and Chronicle merges the sessions on path match.
- **Copilot Chat spans VS Code distributions.** The scanner looks in the `workspaceStorage` of VS Code **stable, Insiders, and VSCodium**, so Copilot sessions from any of those installs are picked up.
- **Cursor and OpenCode share one database across sessions.** Because one file backs many sessions, per-session source-file deletion is disabled for these tools (it is offered only for one-file-per-session sources: Claude Code, Codex, Copilot).

## Known limitations

- **Large sessions degrade gracefully.** Beyond ~5,000 messages, the UI switches to windowed rendering — it draws roughly 400 DOM rows around your current position and decimates timeline ticks — so a 6,000-message session stays responsive. You navigate by search and the timeline rather than an unbounded scroll.
- **Git submodules** are supported by the snapshot engine.
- **Non-standard or custom log paths** are handled through manual selection: use the import wizard's Browse option (or the `CHRONICLE_CURSOR_DIR` / `CHRONICLE_VSCODE_DIR` overrides) to point Chronicle at logs outside the default locations.

## Related

- [Importing sessions](../guide/importing-sessions.md) — the import wizard and the read-only guarantees per source.
- [Parsers & ingestion](../architecture/parsers-and-ingestion.md) — the normalized event model and how to add a seventh source.
