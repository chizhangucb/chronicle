# MCP Hub & Skills Hub Internals

Chronicle ships two control planes for the things AI tools scatter across your machine — MCP server configs and agent skills. Both implement the same pattern: **take over** the scattered sources, **centralize** them in `~/.chronicle`, and **distribute** them back in a namespaced, non-destructive way.

This page is for contributors working on `server/mcp/registry.js`, `server/mcp/hub.js`, `server/mcp/upstream.js`, or `server/skills.js`. It explains how the aggregating MCP server namespaces and routes upstream tools, how the skills store fans out via symlinks, and — most importantly — the safety posture that lets both hubs adopt real user configuration without ever corrupting it. For the user-facing walkthroughs, see [MCP Hub](../guide/mcp-hub.md) and [Skills Hub](../guide/skills-hub.md).

## The shared pattern: Takeover → Centralize → Distribute

Both hubs solve the same problem: a developer runs Claude Code, Cursor, Codex, and Gemini, and each keeps its own copy of "which MCP servers exist" and "which skills are installed." Nothing is shared, edits drift, and secrets sit in plaintext config files.

Chronicle's answer is one control plane per resource:

| Stage | MCP Hub (`server/mcp/`) | Skills Hub (`server/skills.js`) |
| --- | --- | --- |
| **Takeover** | `scanMcpConfigs()` reads each tool's config; `classifyScan()` diffs against the registry | `scanSkills()` reads each tool's `skills/` dir, parses `SKILL.md` |
| **Centralize** | `upsertService()` writes into the `mcp_services` table | `importSkill()` copies the dir into `~/.chronicle/skills` |
| **Distribute** | The `/mcp` endpoint re-exposes every service as namespaced `service__tool` | `linkSkill()` symlinks the central copy into each tool's `skills/` dir |

The safety rule that makes takeover trustworthy is the same in both: **the original sources are never rewritten.** MCP takeover backs up every source config before it touches the registry; skill import *copies* into central storage and leaves the source dir untouched; skill distribution only ever *adds* a symlink and refuses to clobber a real directory. If Chronicle vanished tomorrow, every tool's own config would still be exactly where it was.

## MCP Hub

### The service registry (`server/mcp/registry.js`)

The registry is a thin CRUD layer over one SQLite table, `mcp_services`, plus the scanners that populate it. A service row carries a transport (`stdio | http | sse`), the launch details (`command`/`args`/`env` for stdio, `url`/`headers` for HTTP), an `enabled` flag, the `origin` config it came from, a per-service `disabled_tools` policy list, and an optional `project_path` scope.

Core CRUD:

```js
listServices()                    // all rows, ordered by name
upsertService(entry)              // insert-or-update keyed on unique name
setServiceEnabled(id, enabled)    // policy on/off
deleteService(id)
maskService(s)                    // redact secret-looking env/header values for display
```

`maskService()` is the display gate: every registry value that leaves the API (`GET /api/mcp/services`, `/api/mcp/scan`) is run through it first, so tokens, keys, and `Authorization` headers come back as `abcd…******` rather than plaintext. Nothing in the UI ever sees a raw credential.

**Scanning and classification.** `scanMcpConfigs()` reads the known config locations — `~/.claude.json` (plus per-project `.mcp.json` for imported projects), `~/.cursor/mcp.json`, `~/.gemini/settings.json`, and `~/.codex/config.toml` (via a minimal inline TOML reader, since Codex uses `[mcp_servers.<name>]` sections). `classifyScan()` then diffs each discovered server against the registry and tags it:

| Status | Meaning |
| --- | --- |
| `new` | Not in the registry yet |
| `unchanged` | Present and identical |
| `updated` | Present, changed, and from the **same** origin config |
| `conflict` | Present, changed, but from a **different** origin |

The New/Updated/Conflict split is what drives the takeover review UI — you can see exactly what a one-click import will add versus overwrite.

**Backup before takeover.** `backupSources()` copies every source config file into `~/.chronicle/backups/mcp/<timestamp>/` before any takeover, keeping the last five backup sets. This is the "safe by default" guarantee in code: adoption is reversible.

**Project scoping and Roots.** A service can be bound to a `project_path` via `setProjectPath()`. `servicesForRoot(root)` then routes by **longest-prefix match**: given a client's root, it returns all globally-scoped services plus the *deepest* project scope whose path is a prefix of the root. Passing `'*'` returns everything (the admin/inspector view); passing no root returns globals only. This is how one hub endpoint can expose different toolsets to clients working in different repos.

**Credentials and tool policy.** `setCredential(id, bearer)` stores a per-service bearer token as an `Authorization` header (masked everywhere in output, applied on upstream calls). `setDisabledTools(id, tools)` records a per-service block list; disabled tools are hidden from `tools/list` and rejected on `tools/call`.

### The `/mcp` endpoint (`server/mcp/hub.js`)

The hub is an Express app mounted at `/mcp` that speaks **MCP Streamable HTTP, protocol version `2025-03-26`**. It is deliberately POST-first: clients send JSON-RPC over `POST /`, a `DELETE /` tears down a session, and `GET /` returns `405` (no server-initiated SSE stream is offered, so clients fall back to POST-only mode).

Two protections sit in front of every request:

- **Origin validation (CSRF).** A request carrying a browser `Origin` header is rejected with `403` unless the origin is `localhost`/`127.0.0.1`. Non-browser MCP clients (which send no `Origin`) pass through.
- **Session identity.** `initialize` mints an `MCP-Session-Id` (a UUID) returned in the response header; the client echoes it on subsequent calls. The session also records the client's **root** — from an `x-chronicle-root` header, or the `rootUri` / `workspaceFolders` in the `initialize` params — which is what later `tools/list` calls scope against.

**Aggregation and namespacing.** `aggregateTools(root)` is the heart of the hub. It calls `servicesForRoot(root)` to pick the in-scope services, connects to each in parallel, and flattens their tools into one list — renaming every tool to `<service>__<tool>` and prefixing its description with `[<service>]`:

```js
tools.push({
  ...t,
  name: `${svc.name}${SEP}${t.name}`,          // SEP = "__"
  description: `[${svc.name}] ${t.description ?? ''}`,
});
```

Tools on the service's `disabled_tools` list are filtered out here. Upstream connection errors don't fail the whole list — they're collected per-service into an `errors` map so one broken server doesn't blank the hub.

**Dispatch.** `callTool(namespaced, args)` splits on the first `__`, resolves the service by name, and enforces policy before forwarding: a disabled service or a policy-blocked tool throws (and the block is written to the inspector log as a `blocked` entry). Otherwise it forwards `tools/call` to the upstream client and returns the result verbatim.

**Upstream transports (`server/mcp/upstream.js`).** `connect(service)` bridges the two kinds of upstream:

- **stdio** — spawns the child process, speaks newline-delimited JSON-RPC over its stdin/stdout, and **caches the live child** on `globalThis.__chronicleUpstreams` so repeated calls reuse one process (and survive Vite SSR reloads). The child is initialized once (`initialize` → `notifications/initialized` → `tools/list`).
- **http / sse** — a `fetch`-based Streamable-HTTP client, re-initialized cheaply per hub session, that handles both JSON and `text/event-stream` responses and threads the upstream's own `MCP-Session-Id` through.

So a stdio server and a remote HTTP server look identical to a downstream client: both surface as `service__tool` names in one flat list.

**Status and the Inspector.** `hubStatus()` reports the endpoint, protocol version, service/enabled counts, live session count, and connected stdio children. `hubLog()` returns the ring buffer (last ~300 entries) of every JSON-RPC message in and out — recv/send/blocked/note. That log plus manual `tools/call` is the built-in **Inspector** (`GET /api/mcp/log`, `GET /api/mcp/tools`, `POST /api/mcp/call`), a self-contained way to exercise the hub without an external MCP client.

> **Note:** The `/mcp` endpoint (the aggregating MCP server) is distinct from the `/api/mcp/*` routes (the management REST API that lists services, runs scans, and drives takeover). See [API reference](api-reference.md).

## Skills Hub (`server/skills.js`)

The Skills Hub centralizes agent skills — self-contained directories with a `SKILL.md` — the same way the MCP Hub centralizes servers. Its central store is:

```js
export const CENTRAL_SKILLS = path.join(HOME, '.chronicle', 'skills');
```

### Scan and import

`scanSkills()` walks each tool's skill directory (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.codex/skills`, `~/.gemini/skills`), parses the `SKILL.md` frontmatter for `name`/`description`, and classifies each entry into one of four tiers:

| Tier | Meaning |
| --- | --- |
| `importable` | A real skill dir not yet in the central store |
| `managed` | A symlink already pointing into `CENTRAL_SKILLS` |
| `duplicate` | A skill whose name already exists centrally |
| `broken` | A dangling symlink or a dir with no `SKILL.md` |

`importSkill(sourcePath, origin)` copies the directory into the central store (de-duplicating the name with a numeric suffix if needed) and records a row in the `skills` table. The source directory is copied, never moved — the original tool install is untouched.

`listSkills()` returns every central skill annotated with `linkStatus()` — for each tool, whether Chronicle has a live symlink there, a foreign link, a real directory, or nothing.

### Symlink fanout — strictly additive

Distribution is the deliberate inverse of takeover: instead of copying files around, Chronicle **symlinks** the one central copy into each tool's skills dir, so every tool sees the same skill and an edit propagates everywhere at once.

`linkSkill(skillId, tool)` creates the symlink but **refuses to overwrite**: if a real directory or a foreign link already occupies that path, it throws rather than replace it (on Windows it uses a `junction` so no admin rights are needed). `unlinkSkill(skillId, tool)` is the mirror image and the core safety guarantee — **it only removes a symlink that Chronicle itself created** (verified by resolving it back to `CENTRAL_SKILLS`); pointed at a real directory it refuses and throws. Chronicle can never delete a skill a tool actually owns.

`updateSkillMeta(id, {tags, rating})` stores local-only organizational metadata — tags and a star rating that live in Chronicle's DB and are never uploaded anywhere.

### Version history & snapshots

Every central skill gets an automatic version history under `~/.chronicle/snapshots/<skill>/`, managed by `takeSnapshot(skillId, trigger)`:

- **`imported`** snapshots are permanent — the pristine state at import time.
- **`fs_change`** snapshots are taken by `startSkillWatcher()`, an `fs.watch` on the central store with a **500 ms debounce** per skill, and are kept as a **rolling 50** (oldest pruned).
- Snapshots are **content-hash deduplicated**: `takeSnapshot` hashes the directory tree and skips the write if nothing changed since the last snapshot (except for `imported`, which is always kept).

`listSnapshots()` / `restoreSnapshot(skillId, snapshotId)` give one-click restore. Restore auto-snapshots the current state first (as a `restore` trigger), then replaces the central directory — and because distribution is by symlink, every tool's link keeps working through the swap without any relinking.

### GitHub import & upstream tracking

`importFromGithub(repoUrl, branch='main', subpath='')` does a **shallow clone** (`git clone --depth 1`) into a temp dir, records the resolved commit SHA, walks up to five levels deep for every dir containing a `SKILL.md`, imports each, tags it with `origin_repo`/`origin_sha`, takes an `imported` snapshot, and cleans up the clone. Only public HTTPS URLs are accepted.

`checkUpstream(skillId)` compares the recorded SHA against the remote tip using `git ls-remote` — no clone, just a ref lookup — so you can see at a glance whether a GitHub-sourced skill has drifted from its origin.

## Why this shape

Both hubs are read-mostly control planes over other tools' state, so the design leans hard on non-destructiveness: back up before takeover, copy (never move) on import, add-only symlinks with a strict "only remove what we made" rule, and mask every credential on the way out. That is what makes it safe to point Chronicle at a developer's real, working configuration — the worst case is a stale symlink, never a lost config or a leaked secret. See [Architecture overview](overview.md) for how this fits the six product principles.

## Related
- [MCP Hub](../guide/mcp-hub.md) — the user-facing guide: takeover, policies, Inspector, Roots.
- [Skills Hub](../guide/skills-hub.md) — central store, symlink fanout, GitHub import, versioning.
- [API reference](api-reference.md) — the `/api/mcp/*` management routes and the `/mcp` endpoint.
