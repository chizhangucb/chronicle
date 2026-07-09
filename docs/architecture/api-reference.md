# HTTP API Reference

Chronicle exposes three mounts on one local port: `/api` (the REST API), `/share` (public redacted pages), and `/mcp` (the aggregating MCP server). This page is a route-level reference for contributors and anyone scripting against a running instance.

Everything is served from a single origin — `http://localhost:4173` in dev (`npm run dev`) or `http://localhost:41730` in desktop/standalone — and the exact same Express apps back all three run modes (see [Architecture overview](overview.md)). Requests are local only; the standalone server binds `127.0.0.1`.

## Mounts

| Mount | Source | What it serves |
| --- | --- | --- |
| `/api` | `server/api.js` | The REST API — every route below unless noted |
| `/share` | `server/shares.js` | Public, redacted, tokenized session pages (HTML) |
| `/mcp` | `server/mcp/hub.js` | The aggregating MCP server (Streamable HTTP, JSON-RPC) |

> **Note:** `/mcp` (the MCP protocol endpoint) is **distinct** from the `/api/mcp/*` routes (the management REST API that lists services and drives takeover). Downstream MCP clients talk to `/mcp`; the Chronicle UI talks to `/api/mcp/*`. See [MCP & Skills internals](mcp-and-skills-internals.md).

All paths in the tables below are relative to `/api` — e.g. `GET /projects` is `GET http://localhost:41730/api/projects`.

## Import & scan

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/scan` | Discover importable sessions across all six tools (grouped by logical project) |
| `POST` | `/import` | Import selected sessions into the SQLite store (`replaceSession` per session) |

## Projects

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/projects` | List projects with live git pill info (`repoInfo` runs `git` per call) |
| `GET` | `/projects/:id` | Project analytics home; accepts **`?days=N`** to scope the time range |
| `PATCH` | `/projects/:id` | Rename a project |
| `DELETE` | `/projects/:id` | Delete a project and its sessions from Chronicle |
| `POST` | `/projects/:id/associate` | Associate a virtual (e.g. Gemini) project to a real repo path |
| `POST` | `/projects/:id/sync` | Re-scan and re-import all of a project's sessions |
| `POST` | `/projects/:id/unlink` | Undo an association |

## Sessions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions/:id/messages` | The full message list for a session |
| `PATCH` | `/sessions/:id` | Rename a session (sets the user `name` override) |
| `DELETE` | `/sessions/:id` | Delete the Chronicle copy of a session |
| `DELETE` | `/sessions/:id/source-file` | Delete the underlying source log (only where one file = one session) |
| `POST` | `/sessions/:id/sync` | Re-import just this session (`⇧⌘U` in the UI) |
| `GET` | `/sessions/:id/causality` | Read→change causality analysis (`analyzeCausality`) |
| `GET` | `/sessions/:id/live` | **SSE stream** — live message tail (see below) |
| `GET` | `/sessions/:id/security-check` | Scan the session for secrets (`scanSession` payload) |
| `GET` | `/sessions/:id/export-redacted` | Export the session as redacted Markdown |
| `POST` | `/sessions/:id/share` | Mint a share token (redacted copy frozen at creation) |
| `GET` | `/sessions/:id/replay-plan` | Build the replay step plan (`buildPlan`) |

### The live SSE stream

`GET /api/sessions/:id/live` is **not** JSON — it upgrades to `text/event-stream` and pushes `data:` frames. Frames are either `{ type: 'status', status: 'live' | 'stopped', ... }` or `{ type: 'messages', events: [...] }`. The watcher auto-stops when the connection closes. See [Security, Live & Replay internals](security-live-replay.md).

## Git

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/git/at` | The nearest commit at-or-before a timestamp (`commitAt`) |
| `GET` | `/git/tree` | The file tree at a commit (`treeAt`) |
| `GET` | `/git/file` | A file's contents at a commit + its previous version for diff (`fileAt`) |

These are read-only wrappers over `server/git.js`, which shells out to `git`. See [Git snapshot engine](git-snapshot-engine.md).

## Search

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/search` | `LIKE`-based full-text search over `messages.text` + `tool_input`, grouped per session (empty query → recent sessions) |

## Live

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/live/status` | List active live watchers (`liveStatus`) |

## Security

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/security/rules` | List redaction/allow rules |
| `POST` | `/security/rules` | Add a custom rule |
| `PATCH` | `/security/rules/:id` | Enable/disable a rule |
| `DELETE` | `/security/rules/:id` | Delete a rule |
| `GET` | `/security/interceptions` | Recent pre-tool-use interception records |
| `POST` | `/security/pretooluse` | Scan a tool call; returns `{ decision: 'allow' \| 'block', ... }` (called by the hook) |
| `POST` | `/security/install-hook` | Install the Claude Code PreToolUse hook (backs up settings first) |

## Skills

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/skills` | List central skills (with per-tool link status) |
| `GET` | `/skills/scan` | Scan tool dirs for importable/managed/duplicate/broken skills |
| `POST` | `/skills/import` | Import a scanned skill into the central store |
| `POST` | `/skills/github` | Import skills from a public GitHub repo (shallow clone, records SHA) |
| `GET` | `/skills/:id` | Skill detail + `SKILL.md` content |
| `PATCH` | `/skills/:id` | Update local metadata (tags, rating) |
| `DELETE` | `/skills/:id` | Delete a skill (`?removeFiles=1` to remove central files) |
| `POST` | `/skills/:id/link` | Symlink the skill into a tool's dir |
| `POST` | `/skills/:id/unlink` | Remove a Chronicle-created symlink |
| `GET` | `/skills/:id/snapshots` | List version snapshots |
| `POST` | `/skills/:id/restore` | Restore a snapshot |
| `POST` | `/skills/:id/check-upstream` | Compare recorded SHA to the remote tip (`ls-remote`) |

## MCP management

These manage the registry and drive the hub; they are separate from the `/mcp` protocol endpoint.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/mcp/services` | List registered services (secrets masked) |
| `POST` | `/mcp/services` | Add/update a service |
| `PATCH` | `/mcp/services/:id` | Update a service (enable, scope, credential, tool policy) |
| `DELETE` | `/mcp/services/:id` | Remove a service |
| `GET` | `/mcp/scan` | Scan tool configs, classified New/Updated/Conflict/Unchanged |
| `POST` | `/mcp/takeover` | Import scanned services (backs up source configs first) |
| `GET` | `/mcp/status` | Hub status (protocol version, service/session counts) |
| `GET` | `/mcp/tools` | Aggregated tool list (`aggregateTools('*')`) — Inspector |
| `POST` | `/mcp/call` | Invoke a namespaced `service__tool` — Inspector |
| `GET` | `/mcp/log` | The hub's JSON-RPC ring-buffer log — Inspector |

## Replay

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/replay/preview` | Preview an upcoming step's diff against sandbox state |
| `POST` | `/replay/start` | Create/seed the sandbox from the session-start snapshot |
| `POST` | `/replay/step` | Execute one step (`{ confirmCommand }` required for Bash) |
| `POST` | `/replay/open` | Open the sandbox in the OS file browser |

## Feedback

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/feedback` | Append to `~/.chronicle/feedback.log` and forward to the hosted relay |

## Shares management

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/shares` | List share tokens (views, expiry) |
| `DELETE` | `/shares/:id` | Revoke a share |

And on the `/share` mount:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/share/:token` | The public redacted HTML page (404 once expired/revoked) |

## Data shapes

Message and session rows follow the normalized event model — see [Data model](data-model.md) for the SQLite schema, the `kind` enum (`user \| assistant \| thinking \| tool_use \| tool_result`, plus `note`), and how `replaceSession()` makes import idempotent while preserving the user-set `name`.

One shape worth flagging here: the per-session `sessions.usage` column is JSON keyed by model, with split cache-write buckets:

```json
{
  "claude-opus-4-8": {
    "input": 12000,
    "output": 3400,
    "cacheWrite5m": 800,
    "cacheWrite1h": 0,
    "cacheRead": 45000
  }
}
```

Cost is computed locally from this by `src/models.js` (a static price table) — the logs carry tokens, never dollars.

## Related
- [Architecture overview](overview.md) — single process / single port, run modes, component map.
- [MCP & Skills internals](mcp-and-skills-internals.md) — the `/mcp` endpoint and the `/api/mcp/*` split.
- [Data model](data-model.md) — the SQLite schema and normalized event model behind these routes.
