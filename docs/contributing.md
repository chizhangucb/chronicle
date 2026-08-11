# Contributing

How to set up a development environment, the conventions the codebase follows, and how
changes are verified. If you're new to the internals, read the
[How it works](architecture/how-it-works.md) first.

## Development setup

```bash
git clone https://github.com/chizhangucb/chronicle.git
cd chronicle
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
```

`npm run dev` is the fastest loop: the Express API is mounted inside the Vite dev server, so
both the React UI and the server modules hot-reload in one process on one port.

Other useful commands:

```bash
npm run build       # vite build → dist/ (the static client bundle)
npm run standalone  # production build + headless server (UI + /api) → http://localhost:41730
npm run typecheck   # tsc -b — MUST exit 0 (see the TypeScript section below)
npm test            # node --test 'test/**/*.test.mjs'
```

Chronicle writes all of its data under `~/.chronicle/` (override with `CHRONICLE_DATA_DIR`).
Nothing you do in development touches your source logs or project repositories — Chronicle is
strictly read-only on foreign data. See
[Supported tools & configuration](reference/supported-tools.md) for the full directory layout
and environment variables.

## TypeScript: the no-compile-step rule

Chronicle is mid-migration to `.ts`/`.tsx`, and it's deliberately built around **not having a
build step for the server**. Node 24 strips TypeScript types at load time, so the server
imports and runs `.ts` files directly (`import './db.ts'`, not `./db.js`) — `tsc` here is a
type checker only, never a compiler for dev/local runs. This has real constraints:

- **`npm run typecheck` (`tsc -b`) must exit 0.** That's the whole gate — there's no separate
  build to catch type errors.
- **Erasable-syntax-only.** Node's strip-only loader rejects `enum`, `namespace`, and parameter
  properties (`constructor(private x)`) at runtime. Use `as const` unions instead of enums;
  assign fields in the constructor body.
- **Explicit `.ts`/`.tsx` import extensions, relative imports only.** Once a file is `.ts`,
  every importer's specifier must point at `.ts`/`.tsx` — Node does not rewrite `./x.js` to
  `./x.ts`.
- **Full `strict: true`.** Don't weaken strict mode or silence errors with `any`/`@ts-ignore` —
  type the real shape.
- **`shared/types.ts`** (repo root) is the cross-boundary contract — the normalized event model
  (`Kind`, `Event`, `Usage`, `Session`, …). The server imports it relatively; the client imports
  it via the `@shared` alias.

The one place a real build happens is publishing: `npm run prepack` compiles the server to
plain JS (`dist-server/`) so the published npm package doesn't require Node to strip types from
`node_modules` code. Local dev never touches that path.

## Conventions

- **Keep new endpoints in the existing Express app**, mounted route files under
  `server/routes/`. Add a `mount*` function there and call it from `server/api.ts` so it's
  registered once and works identically in dev and `npm run standalone`.
- **Plain React + one `styles.css`.** There is no UI framework and no chart library beyond
  Recharts wrapped in `src/charts/ChartWrapper.tsx` for the newer views — match the existing
  style rather than introducing a new one.
- **Everything heavy is heuristic and local.** Causality, redaction, cost accounting, and
  Insights aggregation run entirely on-device with no LLM calls. Preserve that offline
  guarantee — never add a network dependency to a core feature.
- **Read-only on foreign systems.** SQLite sources are copied to a temp location (including
  their `-wal`/`-shm` files) before opening; original logs and repos are never written.
- **Long-lived state lives on `globalThis`** (e.g. auto-sync's watchers/timers) so Vite's SSR
  module reloads don't orphan watchers or child processes.
- **Single source of truth for shared vocabulary.** Chat-type labels live only in
  `src/kinds.ts`; per-model context windows and prices live only in `src/models.ts`. Add new
  wording or numbers there, never inline.
- **Destructive or user-visible operations back up first** (under `~/.chronicle/backups/`).
  Deleting a session or project tombstones it rather than silently dropping it, so a later sync
  can't resurrect it by accident; redaction is one-way.

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

There is no full end-to-end test runner wired up beyond `npm test` (parser unit tests against
fixtures in `test/fixtures/`). Beyond that, features are verified end-to-end against real
data. The fastest end-to-end check is to **import Chronicle's own Claude Code session and click
around** — time-travel, causality, and Insights all work on Chronicle's own construction
history.

When you add a new source tool, follow the walkthrough in
[How it works](architecture/how-it-works.md#howto-add-a-new-source) and validate
it against a fixture plus a real session before opening a PR.

## Where things live

The [Architecture](architecture/how-it-works.md) page maps the codebase in detail. In short:

```
server/     Express API (server/routes/) + parsers + Git engine + insights/explore/content
            engines + live streaming + security + auto-sync — runs .ts directly, no build step
src/        React UI (Vite) — plain React + one styles.css
bin/        chronicle.mjs — the npx/CLI launcher
shared/     types.ts — the normalized event model shared by server and client
docs/       This documentation set
```

## Related

- [How it works](architecture/how-it-works.md) — the system design, data model, ingestion, and
  every API route.
