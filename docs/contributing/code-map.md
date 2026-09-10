# Code map

Where things live, and which file owns a given decision. Directories and load-bearing modules
only: a file-by-file inventory goes stale on every PR, so for the rest read the tree.

`package.json` scripts are the source of truth for every command, and `.github/workflows/` for
every gate. When this page disagrees with either, they win and this page is the bug.

## Top level

| Path | What it holds |
| --- | --- |
| `server/` | The Express API, the parsers, the Git engine, the analytics engines. Runs `.ts` natively. |
| `src/` | The React client. Plain React, one `styles.css`, Vite build. |
| `shared/` | Types and logic both sides import. |
| `bin/` | `chronicle.mjs`, the `npx chronicle-cli` launcher. |
| `test/` | `node --test` suites, plus `test/e2e/` for Playwright. |
| `scripts/` | Deterministic mechanics: the `/ask` runner and MCP server, walk seeding. |
| `spec/` | The contracts the release walk judges against. Read by reviewers, not published. |
| `docs/` | The published docs site (guide, reference, architecture, contributing). |
| `docs/agents/`, `docs/adr/` | Agent-only. Excluded from the docs build. |
| `website/` | The getchronicle.dev marketing site and the VitePress config. Its own package. |

## `server/`

**The entry points.** `api.ts` builds the one Express app and mounts every route group.
`standalone.ts` wraps it for production and serves the built `dist/`. Both serve the same app
object, which is the reason an endpoint works in dev and standalone with no per-mode wiring.

**`routes/`** is one file per route group, each exporting a `mount*` function that `api.ts`
calls. `_shared.ts` holds the helpers they have in common. This is where a new endpoint goes.

**`parsers/`** is `claudeCode.ts`, `codex.ts`, `cursor.ts`, `opencode.ts`. Each exports one
thing: the `Source` it implements (`source.ts`) — `scan` for the import wizard's cheap
pre-import listing, `parse` returning `{ session, events }`, `mtime` for freshness, plus
`tail` where the store is an append-only transcript (Claude Code and Codex; the Cursor and
OpenCode stores are SQLite, and live re-reads them instead). `registry.ts` lists the four and
looks one up by id. Import, autosync and live go through the interface and name no source in
code, so adding a fifth coding tool is a parser file and one line in the registry (ADR 0004).
The parser is the only place that knows a tool's native format.

**The core engines:**

| Module | Owns |
| --- | --- |
| `config.ts` | The data folder path, and the read and write of `config.json` |
| `db.ts` | The schema, `replaceSession()`, tombstones, the FTS5 index |
| `git.ts` | Every Git query. Read-only, `execFile`, no libgit2 |
| `autosync.ts` | Watchers, the backstop timer, incremental re-parse |
| `live.ts` | JSONL tail and SQLite poll, pushed over SSE |
| `security.ts` | Detectors, custom rules, `scanText()` / `scanSession()` |
| `insights.ts`, `explore.ts`, `content.ts` | The three analytics engines. `insights.ts` also serves the project page's aggregates (`computeScopedAggregates`) |
| `calibrate.ts` | The one per-bucket token estimator (ADR 0006) |
| `scope.ts` | The query context: scope clause, the one minor gate, and the session/message/token ranges |
| `cache.ts` | The generation-keyed analytics cache |
| `noiseGate.ts` | The `minor` session flag |
| `rangeUsage.ts` | The overlap-based range primitive every ranged route uses |
| `ask.ts`, `askDb.ts` | `/ask`: the pure guard and envelope logic, and the cost surface |

## `src/`

`main.tsx` mounts, `App.tsx` holds the sidebar and the `wouter` routes. Pages are top-level
`.tsx` files; the folders (`cards/`, `charts/`, `components/`, `explore/`, `home/`,
`insights/`, `reference/`, `session/`) hold their pieces.

Three files are single sources of truth and are the reason a shared meaning cannot drift:

- **`kinds.ts`**: `KIND_LABEL` and `KIND_ICON`, imported by every surface that renders an
  event kind.
- **`models.ts`**: per-model prices and context windows. All cost arithmetic starts here.
- **`styles.css`**: the only stylesheet. There is no UI framework; match what is there.

`api.ts` is the client fetch layer and only that: every read and write goes through it, it
declares no response shape (they live in `shared/`), and no component fetches on its own.
`charts/ChartWrapper.tsx` is the only place Recharts is wrapped. The `use*.ts` hooks own
polled and streamed server state.

## `shared/`

`types.ts` is the cross-boundary contract: the normalized event model (`Kind`, `Event`,
`Session`). Both sides import it by relative path. Alongside it: `rows.ts`, `results.ts` and
`explore.ts` (the row and result shapes every route answers with, imported by the engine that
computes each one and the surface that renders it), `usage.ts` (the one token cell, `parseUsage`,
`addCell` and the ranged/bucketed cells every surface reads a session's usage through), `pricing.ts` (the shared cost arithmetic),
`contextWindows.ts`, `provider.ts`, `bucketLabel.ts`, `synthetic.ts`, `spend/` (budget, anomaly,
thresholds), and the three the client used to copy by hand — `errors.ts` (the tool-result error
heuristic), `durations.ts` (agent-active and engaged time, with their two gap caps) and
`sessionName.ts` (the session display name, whose fallback presentation is a parameter).

Something belongs in `shared/` when both sides must agree on it, and only then.

## `test/`

Flat `*.test.mjs` files run by `node --test`, named after the module or behaviour under test.
`fixtures/` holds sample logs, `helpers/` the shared setup, `e2e/` the Playwright specs and
the walk harness.

Two suites are about the repo rather than the product, and both are pins that fail when a
decision quietly unwinds: `repo-shape.test.mjs` guards the directory layout, and
`spec-rules-not-stories.test.mjs` guards how the spec is written.

## `docs/` and `website/`

Docs pages live in `docs/`; the VitePress config, nav and sidebar live in
`website/.vitepress/config.mjs` with `srcDir: 'docs'`. Adding a page means adding the file and
its sidebar entry. `docs/agents/` and `docs/adr/` are excluded from the build.
