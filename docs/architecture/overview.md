# Architecture Overview

Chronicle is a local-first "time machine" for AI coding sessions: it imports conversation logs from six tools, maps every message to the Git snapshot at that moment, and adds an MCP Hub, Skills Hub, security redaction, live streaming, and deterministic replay — all in a single Node process with no cloud backend and no LLM calls.

This page is the map. It explains the one design decision everything else hangs off — **single process, single port** — then walks the component layers, the three run modes, and the product principles that keep the codebase honest. Read it first; the other architecture pages drill into each box.

## Single process, single port

Chronicle is three Express apps and a React UI. The apps are:

| App | Mount | Responsibility |
| --- | --- | --- |
| `server/api.js` | `/api` | All REST routes (scan/import, projects, sessions, git, search, security, skills, MCP management, replay, feedback) |
| `server/shares.js` | `/share` | Public redacted, tokenized share pages served by the local app |
| `server/mcp/hub.js` | `/mcp` | The aggregating MCP server (Streamable HTTP) |

The key move: **the exact same app objects are served in every run mode.** In development they are mounted *into* the Vite dev server; in production a plain Express server (`server/standalone.js`) mounts them directly. Add an endpoint to one of these apps and it works in dev, desktop, and standalone for free — no per-mode wiring.

In dev, `vite.config.js` installs a small plugin (`chronicleApi`) that hangs middleware off Vite's connect server and loads each app lazily per request:

```js
// vite.config.js — one process, one port
server.middlewares.use('/api', async (req, res, next) => {
  const { api } = await server.ssrLoadModule('/server/api.js');
  api(req, res, next);
});
```

The `ssrLoadModule` call is deliberate: it means the API goes through Vite's SSR module graph, so **editing `server/*.js` hot-reloads the API** without restarting the process. You get UI HMR and API hot-reload on the same port (`4173`).

In production there is no Vite. `server/standalone.js` builds an Express app, mounts the same three apps, and serves the built `dist/` for everything else:

```js
// server/standalone.js
app.use('/api', api);
app.use('/share', sharePage);
app.use('/mcp', mcpEndpoint);
app.use(express.static(dist));
app.get(/^\/(?!api|share|mcp).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
```

> **Gotcha — mount an Express *app*, not a Router.** The Vite middleware hands the app a raw Node `req`/`res`. An Express *Router* does not decorate those objects, so `res.json` is `undefined` and every route throws. Mounting a full Express *application* (which installs those response helpers) is what makes the same code run behind Vite and behind `standalone.js`. Keep new endpoints on the apps, not on bare Routers.

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
│  parsers/      claudeCode · codex · cursor · opencode ·       │
│                gemini · copilot   → normalized events         │
│  db.js         projects / sessions / messages  (SQLite)       │
│  git.js        read-only snapshot engine (rev-list/ls-tree)   │
│  live.js       JSONL tail + SQLite poll → SSE                 │
│  replay.js     deterministic sandbox re-execution             │
│  causality.js  read→change linking (heuristic)                │
│  security.js   redaction rules, pre-tool-use check            │
│  mcp/          registry + Streamable-HTTP hub                  │
│  skills.js     central store + symlink fanout                 │
│  shares.js     tokenized redacted /share pages                │
│                                                               │
│  Exposed as three Express apps → /api · /share · /mcp         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────────┐
│  React UI (src/) — plain React + one styles.css, no framework │
│  App.jsx global sidebar · SessionView playback/refine/replay  │
│  hand-rolled SVG charts · i18n (en/zh/ja)                     │
└──────────────────────────────────────────────────────────────┘
```

The layering is strict in one direction that matters: **the server layer has zero Electron imports.** Electron starts the server and owns the window/tray, but nothing under `server/` knows Electron exists. That keeps a future Tauri swap a shell-level change rather than a rewrite (see [Desktop & packaging](desktop-packaging.md)).

## Run modes

All three modes serve the same three apps; they differ only in what wraps them.

| Command | What runs | Port | Notes |
| --- | --- | --- | --- |
| `npm run dev` | Vite dev server + apps mounted via the plugin | `http://localhost:4173` | UI HMR **and** API hot-reload (`ssrLoadModule`) |
| `npm run desktop` | `vite build` → Electron shell + tray | `41730` | Production bundle, window hides to tray |
| `npm run standalone` | `server/standalone.js`, headless | `41730` | Binds `127.0.0.1`; `PORT` override; UI + `/api` + `/share` + `/mcp` |

Electron runs the standalone server internally, so "desktop" and "standalone" are the same server code with or without a window.

### State on `globalThis`

Vite's SSR reloads a module by re-evaluating it. If a watcher or child process lived in a module-scoped variable, a reload would orphan it — the old timer keeps firing, the new module can't see it. Chronicle sidesteps this by parking long-lived singletons on `globalThis`:

- `__chronicleLive` — the live-tail/poll watchers (`server/live.js`)
- `__chronicleHub` — the MCP hub's upstream child processes and sessions
- `__chronicleSkillWatch` — the skills filesystem watcher

Because `globalThis` survives module re-evaluation, a hot-reload rebinds the code without leaking the resources it manages. This is why you can edit `server/live.js` mid-session without piling up watchers.

## Product principles (and why the stack looks like this)

Six principles run through every subsystem. They are worth stating because they explain choices that would otherwise look conservative.

1. **Local-first, offline by default.** Parsing, viewing, and managing a session require no network call. The only deliberate outbound features are the update check, GitHub skill imports, and feedback relay — each opt-in and narrow.
2. **Git is the source of truth for code state.** Snapshots are reconstructed from commit history matched to conversation timestamps — never from a separate snapshot store, never from current disk. See [Git snapshot engine](git-snapshot-engine.md).
3. **Takeover → Centralize → Distribute.** The shared control-plane pattern behind the MCP Hub and Skills Hub: adopt scattered configs, hold them in one place, redistribute (namespaced tools, symlinked skills).
4. **Read-only on foreign systems.** Source logs and project repos are never written. SQLite sources are copied to temp before opening (see [Parsers & ingestion](parsers-and-ingestion.md)); the git engine only reads.
5. **Safe by default.** Replay runs in a sandbox, redaction is one-way, destructive ops back up first and need an explicit click.
6. **Everything heavy is heuristic + local.** Causality confidence tiers, redaction regexes, active-duration math — all local heuristics. **No LLM calls anywhere**, which is what preserves the offline guarantee.

### Key stack decisions

- **`node:sqlite` (`DatabaseSync`), not better-sqlite3.** Zero native compilation, so the app builds and ships without a compiler on the target. The whole schema is created idempotently in module scope; migrations are `try { ALTER TABLE … } catch {}` lines. See [Data model](data-model.md).
- **The git engine shells out to `git`** (`execFileSync`) rather than linking libgit2 — no native dependency, and it matches whatever `git` the developer already trusts.
- **Electron, not Tauri** — the dev machine has no Rust toolchain, and the zero-Electron-imports rule keeps the Tauri path open if the ~100 MB framework floor ever becomes worth shedding.
- **Plain React + one `styles.css`** (CSS variables, dark theme) — no UI framework. **Charts are hand-rolled SVG/CSS** (polyline trends, conic-gradient donuts) — no chart library. Fewer dependencies, smaller bundle, full control.
- **Dependency discipline:** only genuine server-runtime deps (`express`, `electron-updater`) live in `dependencies`; client libs (`react`, `react-dom`, `diff`) are `devDependencies` because Vite bundles them into `dist/` and electron-builder ships everything in `dependencies`.

## Related
- [Data model](data-model.md) — the SQLite schema and the normalized event model every subsystem reads.
- [Parsers & ingestion](parsers-and-ingestion.md) — how the six tools become normalized events, and how to add a seventh.
- [Git snapshot engine](git-snapshot-engine.md) — reconstructing code state from history.
- [Configuration](../reference/configuration.md) — `~/.chronicle/` layout, env vars, `config.json`.
- [Desktop & packaging](desktop-packaging.md) — the Electron shell, signing, and auto-update.
