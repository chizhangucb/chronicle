# Contributing

How to set up a development environment, the conventions the codebase follows, and how
changes are verified. If you're new to the internals, read the
[Architecture overview](architecture/overview.md) first.

## Development setup

```bash
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
```

`npm run dev` is the fastest loop: the Express API is mounted inside the Vite dev server, so
both the React UI and the server modules hot-reload in one process on one port. See the
[Overview](architecture/overview.md) for why the three run modes (`dev`, `desktop`,
`standalone`) all serve the same Express apps.

To exercise the packaged experience:

```bash
npm run desktop    # production build + Electron shell (port 41730, tray)
npm run standalone # headless production server (UI + /api + /share + /mcp)
```

Chronicle writes all of its data under `~/.chronicle/` (override with `CHRONICLE_DATA_DIR`).
Nothing you do in development touches your source logs or project repositories — Chronicle is
strictly read-only on foreign data. See [Configuration](reference/configuration.md) for the
full directory layout and environment variables.

## Conventions

- **Keep new endpoints in the existing Express apps** (`server/api.js`, `server/shares.js`,
  `server/mcp/hub.js`). Because those apps are mounted in all three run modes, a route added
  there works in dev, desktop, and standalone for free.
- **Plain React + one `styles.css`.** There is no UI framework and no chart library — charts
  are hand-rolled SVG/CSS (polylines and conic-gradient donuts). Match that style.
- **Everything heavy is heuristic and local.** Causality, redaction, and cost accounting run
  entirely on-device with no LLM calls. Preserve that offline guarantee — never add a network
  dependency to a core feature.
- **Read-only on foreign systems.** SQLite sources are copied to a temp location (including
  their `-wal`/`-shm` files) before opening; original logs and repos are never written.
- **Long-lived state lives on `globalThis`** (`__chronicleLive`, `__chronicleHub`,
  `__chronicleSkillWatch`) so Vite's SSR module reloads don't orphan watchers or child
  processes.
- **Single source of truth for shared vocabulary.** Chat-type labels live only in
  `src/kinds.js`; per-model context windows and prices live only in `src/models.js`. Add new
  wording or numbers there, never inline.
- **New client-side npm dependencies go in `devDependencies`**, not `dependencies` — Vite
  bundles client libraries into `dist/`, while electron-builder ships everything in
  `dependencies` inside the app. Only genuine server-runtime deps (`express`,
  `electron-updater`) belong in `dependencies`.
- **Destructive or user-visible operations back up first** (under `~/.chronicle/backups/`)
  and require an explicit click. Redaction is one-way; replay runs in a sandbox.

## Branch and PR workflow

Use a branch and a pull request for any non-trivial change — a `fix/…` or `feat/…` branch,
pushed, with `gh pr create`, even when working solo. Reserve direct commits to `main` for
trivial, agreed one-offs. After a PR merges, return your local checkout to `main`:

```bash
git checkout main && git pull && git fetch --prune && git branch -D <branch>
```

The project-card **Git pill** in the UI reads the checkout's live branch on every
`/api/projects` call (no caching), so if it shows a feature branch after a merge, the
checkout is still on that branch — switch back to `main`.

## Verifying changes

There is no unit-test runner wired up. Parsers are validated against fixtures in
`test/fixtures/`, and features are verified end-to-end against real data. The fastest
end-to-end check is to **import Chronicle's own Claude Code session and click around** —
time-travel, causality, and replay all work on Chronicle's own construction history.

Features have been verified against this repo's own session, the `~/health-analyst` repo
(234 commits), the live `anthropics/skills` repo (for GitHub skill import), and fixture
databases/JSON for Cursor, Codex, Gemini, Copilot, and OpenCode-live. Prefer that over mocks:
a real import exercises the whole pipeline (scan → parse → snapshot → render) at once.

When you add a new source tool, follow the walkthrough in
[Parsers & ingestion](architecture/parsers-and-ingestion.md#howto-add-a-new-source) and validate
it against a fixture plus a real session before opening a PR.

## Where things live

The [Architecture](architecture/overview.md) section maps the codebase in detail. In short:

```
server/     Express API + parsers + Git engine + live/replay/security/mcp/skills/shares
src/        React UI (Vite) — plain React + one styles.css
electron/   Desktop shell (tray, single instance, auto-update)
hooks/      chronicle-guard.mjs — the Claude Code PreToolUse hook
docs/       This documentation set
```

## Related

- [Architecture overview](architecture/overview.md) — the system design and run modes
- [Parsers & ingestion](architecture/parsers-and-ingestion.md) — adding a new source tool
- [API reference](architecture/api-reference.md) — every route to build against
