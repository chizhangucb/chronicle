# MCP Hub

A real, aggregating MCP server that runs inside Chronicle: point any AI tool at one endpoint and every MCP service you've configured across every tool shows up through it, with per-tool policies, project scoping, and a built-in inspector.

Most developers accumulate the same MCP servers copy-pasted into four different config files — `~/.claude.json`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` — each drifting out of sync. The MCP Hub replaces that sprawl with a single control plane. Chronicle exposes one Streamable-HTTP endpoint, connects to all your upstream services on your behalf, and re-publishes their tools under stable namespaced names. Configure once, enable/disable and scope centrally, and every tool you point at the hub sees the same governed set. It follows the **Takeover → Centralize → Distribute** pattern shared with the [Skills Hub](./skills-hub.md).

> **Local-first:** the hub connects to whatever upstream servers you configured (some of those may be remote), but the hub itself runs on your machine, binds to localhost, and validates request origins. Chronicle never phones home to broker your MCP traffic.

## The endpoint

The hub is a working MCP server at:

```
http://localhost:4173/mcp     # npm run dev
http://localhost:41730/mcp    # npm run desktop / npm run standalone
```

It speaks **Streamable HTTP** against the **2025-03-26** MCP spec (`server/mcp/hub.js`):

- **POST** carries JSON-RPC. `initialize`, `tools/list`, `tools/call`, `ping`, and `notifications/*` are handled; JSON-RPC batches are rejected.
- On `initialize` the hub mints a session and returns it in the **`MCP-Session-Id`** response header; the client echoes it on later requests. `serverInfo` reports as `chronicle-mcp-hub`.
- **Origin validation** rejects any browser `Origin` that isn't `localhost`/`127.0.0.1` (CSRF protection). Non-browser clients (which send no `Origin`) pass through.
- **DELETE** ends a session; **GET** returns `405` — the hub doesn't offer a server-push SSE stream, so clients simply fall back to POST-only mode.

Point any MCP-capable tool at that URL. In a tool's own MCP config, add an HTTP server entry whose `url` is the hub endpoint:

```jsonc
{
  "mcpServers": {
    "chronicle": { "type": "http", "url": "http://localhost:4173/mcp" }
  }
}
```

### Namespaced tools

Every upstream tool is re-published as **`service__tool`** (double underscore separator). A `filesystem` server's `read_file` tool becomes `filesystem__read_file`, and each tool's description is prefixed with `[service]` so the origin is obvious to the model. When a client calls `tools/call` with a namespaced name, the hub splits it, finds the owning service, and routes the request to the right upstream — a mix of **stdio child processes** and **remote HTTP servers**, whichever you configured.

The **MCP Hub** page header shows live status: the endpoint, how many services are enabled, how many client sessions are connected, and a green pill per connected stdio child (its PID and tool count).

## Config takeover

Open **MCP Hub → Config takeover** to import what you've already configured. Chronicle scans (`scanMcpConfigs()` in `server/mcp/registry.js`):

| Source | File |
| --- | --- |
| Claude Code (user) | `~/.claude.json` |
| Claude Code (project) | `.mcp.json` in each imported project |
| Cursor | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` (TOML `[mcp_servers.*]` sections) |

Each discovered server is classified (`classifyScan()`) so you know exactly what an import will do:

- **New** — not yet in the hub.
- **Updated** — already imported from the same source, but its command/args/env/url/headers changed.
- **Conflict** — a service of the same name exists but came from a *different* tool's config (the definitions disagree).
- **Unchanged** — identical to what's already registered; skipped.

Click **Import** and Chronicle backs up every source file to `~/.chronicle/backups/mcp/<timestamp>/` (keeping the last five sets) **before** writing anything, then registers the New/Updated/Conflict entries. Your original config files are **never rewritten** — takeover is a one-way copy *into* Chronicle, so removing the hub later leaves your tools exactly as they were.

## Managing services

The **Services** tab lists every registered upstream with its transport (`stdio` / `http` / `sse`), its origin config, and its command or URL.

- **Enable / disable** per service — a disabled service is hidden from `tools/list` and refuses `tools/call`.
- **Remove from hub** drops the registry entry only; the source config it came from is untouched.
- **Secrets are masked.** Any env var whose key looks like a credential (`token`, `key`, `secret`, `pass`, `auth`) or whose value is long, and every header value, is masked in all API output (`maskService()`). Chronicle stores the real values locally to make upstream calls but never returns them raw to the UI.

### Tool policies

Enabling a whole server is often too coarse — you want its read tools but not its write tools. Click **⛭ policy** on a service to open its tool panel: uncheck any tool and it is both **hidden from `tools/list`** and **blocked on `tools/call`**. A blocked call is recorded in the inspector log rather than silently dropped, so you can see what a client tried to reach. Policies are stored per service (`setDisabledTools()`), so the same governed surface applies to every tool that connects through the hub.

### Project scoping (MCP Roots)

A service can be **scoped to a project path** so it only appears to clients working inside that project. When a client connects, the hub reads its **root** — from an explicit `x-chronicle-root` header, or the `rootUri` / `workspaceFolders` in its `initialize` params — and routes `tools/list` by **longest-prefix match** (`servicesForRoot()`):

- A client rooted inside a scoped project sees the **deepest matching** scoped service plus all unscoped (global) services.
- A client with no root, or a root outside every scope, sees only the global services.

This keeps a project-specific database or deployment server out of unrelated sessions without maintaining separate config files per repo.

### Per-service credentials

For remote HTTP services, attach a **bearer token** to a service (`setCredential()`); the hub applies it as an `Authorization: Bearer …` header on upstream calls and masks it everywhere in the UI. The token is stored locally alongside the service definition.

## The Inspector

The **Inspector** tab is a built-in MCP client for debugging the hub without leaving Chronicle:

- **Manual tool invocation** — pick any namespaced tool from the live list, supply JSON arguments, and call it. The result renders inline. If an upstream service failed to connect, its error shows here per service.
- **JSON-RPC log** — a rolling ring buffer of the last requests and responses through `/mcp` (received, sent, blocked-by-policy, notifications), newest first. This is where a blocked `tools/call` and any routing error surface.

Use it to confirm a takeover worked, verify a tool policy is filtering correctly, or reproduce what a connected AI tool is seeing.

## The pattern, end to end

1. **Takeover** — import the MCP servers scattered across your tool configs, with an automatic backup.
2. **Centralize** — enable/disable, scope to projects, set tool policies, and attach credentials in one place.
3. **Distribute** — point Claude Code, Cursor, Gemini, or any MCP client at `http://localhost:4173/mcp`. They all share the same governed, namespaced tool set, and a policy change applies everywhere at once.

For the wire-level details — how upstream connections are pooled, how `tools/list` aggregation and error handling work — see the architecture notes below.

## Related

- [Skills Hub](./skills-hub.md) — the same Takeover → Centralize → Distribute pattern applied to agent skills.
- [Security and sharing](./security-and-sharing.md) — redaction, the pre-tool-use guard, and safe share links for sessions.
- [MCP & Skills internals](../architecture/mcp-and-skills-internals.md) — the registry, upstream connection layer, and Streamable-HTTP implementation.
- [API reference](../architecture/api-reference.md) — the `/mcp` endpoint spec and the `/api/mcp/*` management routes (distinct from each other).
