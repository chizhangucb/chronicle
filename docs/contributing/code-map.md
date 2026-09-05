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

**`parsers/`** is `claudeCode.ts`, `codex.ts`, `cursor.ts`, `opencode.ts`. Each exports a cheap
`scan*Projects()` for the import wizard and a parse function returning `{ session, events }`.
The parser is the only place that knows a tool's native format.

**The core engines:**

| Module | Owns |
| --- | --- |
| `db.ts` | The schema, `replaceSession()`, tombstones, the FTS5 index |
| `git.ts` | Every Git query. Read-only, `execFile`, no libgit2 |
| `autosync.ts` | Watchers, the backstop timer, incremental re-parse |
| `live.ts` | JSONL tail and SQLite poll, pushed over SSE |
| `security.ts` | Detectors, custom rules, `scanText()` / `scanSession()` |
| `causality.ts` | Read-to-change linking with confidence tiers |
| `insights.ts`, `explore.ts`, `content.ts` | The three analytics engines |
| `calibrate.ts` | The one per-bucket token estimator (ADR 0006) |
| `scope.ts` | `Scope` to SQL, plus `minorGate()` |
| `cache.ts` | The generation-keyed analytics cache |
| `errors.ts` | The one server-side tool-result error heuristic |
| `noiseGate.ts` | The `minor` session flag |
| `durations.ts` | Agent-active and engaged time, computed at import |
| `windowUsage.ts` | The overlap-based windowing primitive every windowed route uses |
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

`api.ts` is the client fetch layer. `charts/ChartWrapper.tsx` is the only place Recharts is
wrapped. The `use*.ts` hooks own polled and streamed server state.

## `shared/`

`types.ts` is the cross-boundary contract: the normalized event model (`Kind`, `Event`,
`Usage`, `Session`). The server imports it relatively; the client imports it via the `@shared`
alias. Alongside it: `pricing.ts` (the shared cost arithmetic), `contextWindows.ts`,
`provider.ts`, `bucketLabel.ts`, `synthetic.ts`, and `spend/` (budget, anomaly, thresholds).

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
