# Configuration

Where Chronicle keeps its data, the environment variables it reads, and the handful of things you can override.

Chronicle needs almost no configuration — it works out of the box against your tools' default log locations and stores everything under a single directory in your home folder. This page documents that directory, the environment variables each part of the app reads, the optional `config.json`, and the ports. There is no settings server and no account; overrides are files and env vars only.

## The `~/.chronicle/` directory

Everything Chronicle writes lives under one base directory (`~/.chronicle` by default; see `CHRONICLE_DATA_DIR` below). It is created idempotently on first run.

| Path | What it holds |
| --- | --- |
| `chronicle.db` | The SQLite database — all projects, sessions, and messages. Opened via `node:sqlite` (`DatabaseSync`), no native compile |
| `skills/` | The central Skills Hub store (`CENTRAL_SKILLS`), symlinked out to each tool's skills directory |
| `snapshots/` | Skill version history (import snapshots + debounced filesystem-change snapshots) |
| `backups/mcp/` | Backups of MCP configs taken before a one-click takeover (sources are never rewritten in place) |
| `replay/<id>/` | Per-run Replay sandboxes, seeded from the Git snapshot at session start |
| `feedback.log` | Every feedback submission, appended locally *before* any network send |
| `config.json` | Optional user overrides (see below) |

> **Note:** `backups/` is also where other destructive or user-visible operations (hook install, restores) back up first — Chronicle always writes a backup before it changes anything you could miss.

## Environment variables

Each variable is read by a specific file, noted in the last column. Unset variables fall back to the defaults shown.

| Variable | Default | Purpose | Read by |
| --- | --- | --- | --- |
| `CHRONICLE_DATA_DIR` | `~/.chronicle` | Base directory for the database and all state above | `server/db.js` (DB path) and `server/api.js` (feedback log, `config.json`) |
| `CHRONICLE_FEEDBACK_RELAY` | `relay.getchronicle.dev` | Override the hosted feedback relay URL | `server/api.js` |
| `CHRONICLE_CURSOR_DIR` | Cursor's VS Code `workspaceStorage` | Point the Cursor parser at a non-standard location | `server/parsers/cursor.js` |
| `CHRONICLE_VSCODE_DIR` | VS Code / Insiders / VSCodium user dirs | Point the Copilot Chat parser at a non-standard VS Code user directory | `server/parsers/copilot.js` |
| `CHRONICLE_URL` | `http://localhost:4173` | Where the pre-tool-use guard hook posts scan requests | `hooks/chronicle-guard.mjs` |
| `PORT` | `41730` | Port for the headless standalone server | `server/standalone.js` |

> **Note:** `CHRONICLE_DATA_DIR` is the only environment variable for the data directory. Inside `server/api.js` its resolved value is held in a constant named `CHRONICLE_DIR` — that is an internal name, not a second variable, so set `CHRONICLE_DATA_DIR` and both the database and the feedback log follow.

## `config.json` overrides

Drop a `config.json` in the data directory to set persistent overrides without environment variables. Today the one supported key is the feedback relay:

```json
{
  "feedbackRelay": "https://relay.example.com/feedback"
}
```

Precedence for the relay URL is: `CHRONICLE_FEEDBACK_RELAY` env → `feedbackRelay` in `config.json` → the built-in default (`relay.getchronicle.dev`). Feedback always appends to `feedback.log` locally first, so nothing is lost if the relay is unreachable.

## Ports and binding

All three run modes serve the same Express apps (`/api`, `/share`, `/mcp`); they differ only in port and shell.

| Mode | Port | Bind |
| --- | --- | --- |
| `npm run dev` | `http://localhost:4173` | localhost |
| `npm run desktop` (Electron) | `41730` | loopback |
| `npm run standalone` | `41730` (override with `PORT`) | `127.0.0.1` |

The standalone server binds explicitly to `127.0.0.1`, so it is reachable only from your own machine — Chronicle never listens on a public interface.

> **Single-instance lock:** only one Chronicle can run per machine. The Electron shell takes a single-instance lock and holds port `41730`, so a second launch (packaged app, `electron .`, or a stale `standalone.js`) exits silently rather than double-binding. If the UI 404s unexpectedly, a stale server may be holding the port — check `lsof -iTCP:41730`.

## Related

- [Installation](../guide/installation.md) — install paths, run modes, and requirements.
- [Privacy & data](./privacy-and-data.md) — exactly what is stored locally and the short list of outbound calls.
- [Architecture overview](../architecture/overview.md) — why one process and one port serve every mode.
