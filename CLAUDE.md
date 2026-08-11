# Chronicle — project notes for Claude

Local-first AI coding session manager ("time machine"): imports logs from 4 AI tools
(Claude Code, Codex, Cursor, OpenCode), maps every message to a Git code snapshot, plus
security redaction, live streaming, a tabbed **Insights** analytics home
(Overview/Explore/Content) with first-class **Subagents**, and invisible incremental
auto-sync. Ships as a local web app via **`npx chronicle-cli`** (Node 24+) — no desktop
shell, no cloud, zero outbound network calls. (v0.2.0 removed the MCP Hub, Skills Hub, and
guard hook; the v1.0 re-ramp removed the Electron desktop shell, replay, share links, the
feedback relay, and the Copilot/Gemini parsers.) Layered docs (guide / reference /
architecture): `docs/`, published at getchronicle.dev/docs. Feature summary: `README.md`.

## Commands

```bash
npm run dev        # Vite dev server + API in one process → http://localhost:4173
npm run standalone # headless production server (npm run build + node server/standalone.ts; UI + /api)
npm run build      # vite build → dist/
npm run typecheck  # tsc -b  (type gate — MUST exit 0)
npm test           # node --test 'test/**/*.test.mjs'
```

`npx chronicle-cli` runs the published build (see **npm / npx** below). CI
(`.github/workflows/ci.yml`) gates `main` + every PR on typecheck + test + build, on Node 24.
Parsers are validated against fixtures in `test/fixtures/` plus real data end-to-end (see
Verification below).

## npm / npx

- Published as the unscoped, public package **`chronicle-cli`** (`npx chronicle-cli`; bin
  aliases `chronicle` + `chronicle-cli` → `bin/chronicle.mjs`). Data at
  `~/.chronicle/chronicle.db` (override: `CHRONICLE_DATA_DIR`).
- **`bin/chronicle.mjs` is a Node-built-ins-only launcher** (no deps): Node ≥24 preflight,
  `--port <n>` / `--no-open` flags, a bounded free-port scan from 41730, opens the default
  browser (best-effort, never fatal), then `import()`s the COMPILED server
  (`dist-server/server/standalone.js` → `startServer(port, distDir)`, passing the client
  `dist/` path explicitly) and runs in the foreground until Ctrl-C.
- **Node ≥24 floor + WHY.** Two reasons: (1) `node:sqlite` (DatabaseSync) needs Node 24;
  (2) dev runs `.ts` natively via Node's type-stripping, but **Node REFUSES to strip-type
  `.ts` files under `node_modules`** — so the published tarball cannot ship raw `.ts`. At
  publish the server is COMPILED to `dist-server/` by **`tsc -p tsconfig.publish.json`**
  (`rewriteRelativeImportExtensions` rewrites `./x.ts` → `./x.js`; emits runnable ESM).
  Wired into **`prepack`** = `rm -rf dist-server && npm run build && tsc -p tsconfig.publish.json`.
- **`files` allowlist** = `["bin","dist","dist-server"]` — only the launcher, the Vite
  client build (`dist/`), and the compiled server (`dist-server/`) ship. Source `.ts`,
  tests, docs, and `superpowers/` stay out of the tarball.
- **`prepublishOnly`** = `npm run typecheck && npm test` — the publish gate (also
  re-run in CI).
- **Publish + smoke:** `npm publish` (unscoped → public by default), verify
  `npm view chronicle-cli version`. Then the LOAD-BEARING **clean-dir npx smoke**:
  `cd $(mktemp -d) && npx chronicle-cli --no-open --port <n>`, curl `/` → `200`, import one
  session via the UI, confirm it renders. `express` is the only runtime `dependency`
  (client libs are devDeps — Vite bundles them into `dist/`).

## TypeScript

Incremental migration to `.ts`/`.tsx`, keeping the **no-compile-step** architecture for
DEV. TypeScript is a DEV type gate; it never emits in dev (publish is the one exception —
see npm / npx above, where `tsconfig.publish.json` compiles the server for the tarball).

- **Node runs `.ts` natively.** Node 24 strips types at load — no build step, no flag.
  So the server executes `.ts` directly (`import './db.ts'` etc.). `tsc` is only the
  type checker: **`npm run typecheck`** (= `tsc -b`) MUST exit 0.
- **Erasable-syntax-only.** Node's strip-only loader REJECTS `enum`, `namespace`,
  parameter properties (`constructor(private x)`), and other non-erasable TS at runtime
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Enforced by `erasableSyntaxOnly: true`. Use
  `as const` unions instead of enums; assign fields in the constructor body.
- **Explicit `.ts`/`.tsx` import extensions (Option A), relative imports only.** Node does
  NOT rewrite `./x.js` → `x.ts`, so once a file becomes `.ts` every importer's specifier
  must point at `.ts`/`.tsx` (a `.js`/`.jsx` file importing `./foo.ts` is fine for Vite and
  Node). tsconfig sets `allowImportingTsExtensions` + `noEmit`.
- **`shared/types.ts` (repo root) is the cross-boundary contract** — the normalized event
  model (`Kind`, `Event`, `Usage`, `Session`…), framework-free. Server imports it relatively
  (`../shared/types.ts`); the client imports it via the **`@shared`** alias (in
  `vite.config.js` `resolve.alias` AND `tsconfig.client.json` `paths`, kept in sync). Its
  names/optionality track the real parser + `db.ts` shapes — change them together.
- **Full `strict: true`** (`noImplicitAny` + `strictNullChecks` on). Do NOT weaken strict or
  silence errors with `any`/`@ts-ignore`/`@ts-expect-error`; type the real shape instead.
- Two projects via references (`tsconfig.json` → `tsconfig.server.json` nodenext +
  `tsconfig.client.json` bundler/jsx), sharing `tsconfig.base.json`; `tsconfig.publish.json`
  is the separate publish-time server compile. `typescript` is pinned exact; client libs'
  `@types/*` are devDeps (Vite bundles the client).

## Architecture decisions (and why)

- **Single process, single port.** The Express app (`server/api.ts`, assembled from
  `server/routes/*`) is mounted INTO the Vite dev server via a plugin in `vite.config.js`
  using per-request `ssrLoadModule` (gives API hot-reload). The same app is served without
  Vite by `server/standalone.ts` (mounts `/api` + serves the static client `dist/`), which
  is what `npx chronicle-cli` launches. Keep new endpoints in these express routes and they
  work in all run modes for free.
- **`node:sqlite` (DatabaseSync), not better-sqlite3** — zero native compile. DB at
  `~/.chronicle/chronicle.db` (override: `CHRONICLE_DATA_DIR`). Schema is created
  idempotently in module scope; migrations are `try { ALTER TABLE … } catch {}` lines.
- **Git snapshot engine shells out to `git`** (`server/git.ts`) — read-only:
  `rev-list --before` (commit at timestamp), `ls-tree`, `show`, `diff-tree`. No libgit.
- **Normalized event model** — every parser flattens tool-native logs into rows of
  kind `user | assistant | thinking | tool_use | tool_result` with `ts`, `tool_name`,
  `tool_input` (JSON string), `tool_use_id` (pairs calls↔results). Add new sources as
  `server/parsers/<tool>.ts` exporting `scan<Tool>Projects()` + a parse function, then
  wire into the scan/import routes in `server/routes/import-sync.ts` and `SOURCES` in
  `src/ImportWizard.tsx`. Four sources today: claudeCode, codex, cursor, opencode.
- **Logical projects** key on the physical `cwd` recorded in logs; a "Needs association"
  banner merges sessions on path match.
- **Read-only on foreign data, always**: SQLite sources (Cursor, OpenCode) are copied
  to temp **including `-wal`/`-shm`** before opening; original logs are never written.
- **Everything heavy is heuristic + local** (causality confidence tiers, redaction
  regexes, Insights calibration) — no LLM calls, no outbound network anywhere, preserving
  the offline guarantee.
- **Repo is flat** (Chi's global preference): app code at root, PRD in `docs/`.
- **Navigation is real URL routes (wouter).** `/` (Home), `/project/:id`, `/session/:id`.
  The URL IS the persisted state, so any reload (including the language switch's
  `location.reload()`) restores the current view for free — no `sessionStorage` hack.
  There is one collapsible left sidebar (in `App.tsx`, collapse state in `localStorage`);
  SessionView doesn't render its own rail — it publishes `{modes, active, select,
  securityOpen}` up via the `onRailChange` prop while mounted, and App renders those as
  sidebar items. SessionView is keyed by session id so the breadcrumb session switcher
  remounts it cleanly.
- **Top-bar Search + Import are global, not Home-only.** The `.topbar-right` 🔍 Search
  (⌘K palette) and "+ Import Sessions" render in EVERY view; import/search work from
  anywhere and refresh projects. Only the LIVE pill stays session-scoped.
- **Home multi-select delete uses an inline confirm, never `window.confirm`.** `HomePage`
  has a "Select" mode: cards become checkboxes (`selectMode`/`selected` Set), with
  Select-all/Clear/Cancel + a danger "Remove (N)". Deletion is a two-step INLINE confirm
  bar (`confirming` state) — NOT `window.confirm`, which is blocked in embedded/preview
  browsers. It loops `api.deleteProject` (source logs untouched) then refreshes.
- **Latest `cwd` wins when resolving a session's project.** Sessions resumed after a
  repo move keep the old path in early JSONL records; scanner and parser use the last
  seen cwd (where the repo and its Git history live now) and collapse subdirectory
  cwds up to a seen ancestor (`reduceCwd`). The scanner sniffs both the head and tail
  64 KB of each file for this.
- **Session display name = `name` (Chronicle override) → `summary` (parsed) →
  `first_prompt`.** `sessionDisplayName()` in `ProjectDetail.tsx` is the single
  source of that precedence; reuse it everywhere (rows, pickers, overview title).
  The parser reads Claude Code's `{"type":"custom-title","customTitle":…}` lines
  (the `/rename` title, LAST one wins) into `sessions.summary`; there are NO
  `type:"summary"` lines in real logs, so custom-title is the only auto-title
  source. `name` is a user-set override, preserved across re-import (see below).
- **Cost is computed locally, never billed data.** Logs carry tokens, not dollars,
  so the parser aggregates per-model token totals (`sessions.usage` JSON:
  `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`) and
  `src/models.ts` multiplies by a static per-model price table. 5-minute and
  1-hour cache writes are billed at different rates — keep them split. The table
  must track the current Anthropic pricing page (Opus 4.8 tier is $5/$25, NOT the
  old Opus 4.1 $15/$75 — getting this wrong 3× inflates every number). The Overview
  Cost & Usage block DISPLAYS the two tiers separately (tokens + $), each with a
  `5m`/`1h` `.ttl-tag`: `cacheWriteByTtl()` / `cacheWriteCostByTtl()` in `models.ts`
  split them (legacy `{cacheWrite}` logs are treated as 5m). **The price table lives ONLY
  in `src/models.ts` (client-pure); it is NEVER duplicated server-side** — the Explore
  engine returns metric-agnostic per-model token cells and the client prices Spend via
  `costOf`.
- **Global search is FTS5 with a LIKE fallback.** `/api/search` (`server/routes/search.ts`)
  runs an FTS5 `MATCH` (phrase query, prefix on the last term) over `messages.text` +
  `tool_input` when the `messages_fts` external-content virtual table is available, and
  falls back to `LIKE` otherwise; results are grouped per session (top ~400 rows) with a
  snippet. Empty query returns recent sessions ("Recent Access").
- **Chat-type labels have ONE source of truth: `src/kinds.ts`.** `KIND_LABEL`/`KIND_ICON`
  (role-accurate: User / Assistant / Thinking / Tool Call / Tool Result / Inserted) are
  imported by Playback (`SessionView` `KIND_META`), Refine (`RefineMode`, uppercased for
  its tag look), and the Refine export. Put new label wording here, never inline.
- **"Agent Active" (labeled thus, was "Active Duration") = agent working time, excluding
  only real human turns.** `activeDurationMs()` sums every inter-message gap EXCEPT the gap
  leading into a genuine human prompt. The catch: **not every `user`-role message is a human
  prompt** — `<task-notification>` (a background build finishing), `<launch-selected-element>`
  (UI element pick), `<system-reminder>`, `<command-name>`/`<local-command…>`, and
  `[Request interrupted…]` all log with role=user. `isHumanPrompt()` filters those via
  `SYNTHETIC_USER_RE`, so their preceding gap counts as ACTIVE (the agent was busy) — only a
  typed prompt subtracts time. The canonical stored durations live in `server/durations.ts`
  (Agent Active with a 10-min cap + tool_result exemption; Engaged with a 90-min cap),
  computed at import. Shown with an `InfoTip` (ⓘ) explainer; its key IS the full English
  sentence.
- **Language switch keeps your place.** `setLang` `location.reload()`s — many `t()` calls
  run at module scope (e.g. `FILTER_CHIPS`), so a full reload is the only clean
  re-translate. The URL route (not `sessionStorage`) restores your view on reload.
- **Invisible sync.** Background incremental import keeps sessions fresh with no manual
  re-import: `server/autosync.ts` watches the source log dirs (mtime > `imported_at`,
  30-min backstop, debounce; state on `globalThis`) and re-imports changed sessions.
  **Noise gate** (`server/noiseGate.ts`): a session is "minor" when its agent-active time
  is under the threshold (default 5 min) OR it has fewer than N messages (default 10), both
  tunable via `~/.chronicle/config.json`. `isMinorSession()` is applied uniformly at
  INSERT time in `db.ts` `replaceSession`, so it covers manual import, per-project/-session
  sync, AND auto-sync alike; minor sessions land in a single "minor sessions" bucket
  (promote / ignore actions) instead of cluttering the main lists. **Tombstones**: deletes
  are recorded so a re-sync doesn't resurrect a removed session. Sync can be paused.

### Insights / Explore / Content engine (server/scope.ts · explore.ts · content.ts · calibrate.ts · insights.ts)

- **Scope + minor gate are ONE primitive.** `server/scope.ts` turns a
  `Scope = {type: 'all'|'project'|'session', id?}` into a SQL `WHERE` fragment + bind
  params (`s` is the sessions alias every engine query uses); a missing id degrades to
  `'all'` rather than emitting a broken `= NULL`. `minorGate(scope)` returns
  `AND COALESCE(s.minor,0)=0` for `'all'`/`'project'` but **`''` for a directly-opened
  session** — session scope already restricts to one session, so the minor exclusion (meant
  for aggregates) would wrongly blank the pane. Both are ANDed onto every engine query.
- **Token MAGNITUDE comes from authoritative `sessions.usage`, not per-message columns.**
  Per-message token columns capture only ~0.73 of billed usage (~27% is never stored
  per-row, ~70% of what is stored sits on tool_use rows), so they can't reconcile. Explore's
  `EXACT_USAGE_GROUPS` (`model`/`project`/`source`) source `tokensByModel` from the parsed
  `sessions.usage` per-model billed cells (= Overview / Insights / Claude `/usage`);
  requests/sessions/errors/activeMs stay per-message (their natural units). `hour`/`subagent`
  are inherently message-level and stay per-message by design.
- **Calibration is ONE shared primitive** (`server/calibrate.ts` `calibrateByBucket`).
  Chronicle bills tokens per assistant turn, not per tool-call/kind, so "tokens
  attributable to X" is estimated as X's share of message TEXT LENGTH scaled to the real
  billed total. `tool`/`skill` × tokens in Explore and the whole Content composition are
  calibrated; any result built from it sets **`calibrated: true`** so the UI badges it.
- **Tool-results pair to their tool_use via `MIN(id)`.** Content's tool-results-by-tool and
  Explore's per-group error attribution join a `tool_result` to exactly ONE `tool_use` with
  `u.id = (SELECT MIN(u2.id) FROM messages u2 WHERE u2.session_id=r.session_id AND
  u2.tool_use_id=r.tool_use_id AND u2.kind='tool_use')` — the earliest matching row, so each
  erroring result is counted ONCE, not multiplicatively cross-joined against every
  co-resident tool_result.
- **Index the pairing join.** `idx_messages_tooluse ON messages(session_id, tool_use_id)`
  (in `db.ts`) makes that correlated subquery non-quadratic; without it SQLite can only
  search the tool_use side by `session_id`. Measured on the maintainer's ~395 MB / 101k-row
  real DB, this index alone cut `/api/explore` materially. (`idx_messages_session` on
  `(session_id, seq)` + `idx_sessions_project` are the other two.)
- **Subagents are first-class sidechain rows.** Subagent (sidechain) turns import with
  `agent_type`/`skill` attribution and per-message token usage; Content's subagent token
  share is **EXACT** from those per-message sidechain columns (skill share is calibrated).
  The session view surfaces them in an Overview **Subagents** card + a per-subagent drill-in
  (`SessionMode` includes `'subagent'`, reached only via that card, not the sidebar rail).
- **Insights hub** (`server/insights.ts`) mirrors the per-project analytics shapes
  (`server/routes/projects.ts`) but across ALL projects — same `COALESCE(minor,0)=0` gate,
  same `days=` cutoff, same `ERROR_RE` heuristic. `dailyActivity`/`hourlyActivity` are
  DELIBERATELY exempt from `days=` (Working Rhythm always shows a fixed trailing 182-day
  calendar + trailing 30-day hour-of-day heatmap).

## Key files

- `bin/chronicle.mjs` — `npx chronicle-cli` launcher (Node built-ins only; see npm / npx).
- `tsconfig.publish.json` — publish-time server compile → `dist-server/` (`prepack`).
- `server/db.ts` — schema (projects/sessions/messages) + indexes + FTS5 + `replaceSession`
  transaction (applies the noise gate, preserves `name`).
- `server/api.ts` — assembles the Express app from `server/routes/*` (projects, sessions,
  import-sync, search, git, security, settings, insights, explore, content); starts the
  auto-sync watchers on load.
- `server/git.ts` — snapshot engine; `commitsBetween` pads ±10 min for timeline ticks.
- `server/parsers/` — claudeCode, codex, cursor, opencode → normalized event model.
- `server/live.ts` — JSONL tail (`Watcher`) + SQLite poll (`SqlitePollWatcher`) → SSE.
- `server/causality.ts` — read→change linking, confidence 0.95/0.55/0.5/0.45/0.2.
- `server/security.ts` — redaction rules, `scanSession`, interceptions.
- `server/autosync.ts` — incremental auto-sync (mtime > imported_at; watchers, 30-min
  backstop, debounce; state on globalThis); settings in `~/.chronicle/config.json`.
- `server/noiseGate.ts` — `isMinorSession()` (minor bucket) + thresholds.
- `server/durations.ts` — canonical Agent Active (10-min cap, tool_result exemption)
  + Engaged (90-min cap), stored on sessions at import.
- `server/scope.ts` · `explore.ts` · `content.ts` · `calibrate.ts` · `insights.ts` — the
  Insights engine (see the Insights/Explore/Content section above).
- `src/App.tsx` — global sidebar (collapse in localStorage), URL routing (wouter), LIVE
  pill, always-on top-bar Search/Import, `HomePage` multi-select delete flow.
- `src/SessionView.tsx` — the core session view; registers modes (overview/playback/refine
  + Security Check, ⌘1–⌘3) into the sidebar via `onRailChange`; owns filtering, windowing,
  live SSE, causality panels, the breadcrumb session switcher, the `⇧⌘U` per-session sync
  shortcut, the Subagents drill-in, and the Overview stats page.
- `src/InsightsPage.tsx` · `src/ExploreTab.tsx` · `src/ContentTab.tsx` — the tabbed Insights
  hub (Overview / Explore / Content) that consumes the `/api/insights|explore|content`
  engine routes.
- `src/ProjectDetail.tsx` — project analytics home with Overview/Explore/Content/Sessions
  tabs; also exports `sessionDisplayName()`, `ProjectPicker`, `SessionPicker`. The `days`
  for "Today" is fractional-days-since-local-midnight, memoized on `range`.
- `src/models.ts` — static per-model tables (never fetched): context windows +
  list-price table (`pricingFor`, `costOf`, `costBreakdownOf`, `cacheWriteTokens`,
  `cacheWriteByTtl`, `cacheWriteCostByTtl`). Update when models/prices change.
- `src/kinds.ts` — the canonical `KIND_LABEL`/`KIND_ICON` maps (see the labels decision).
- `src/i18n.ts` — `t()` looks up `DICTS[lang()]` (zh + ja dicts, English is the key
  itself); `setLang` reloads the page. Add a locale = add a dict here. **Because English IS
  the key, a long explainer's key must BE the full English sentence, not a short label** —
  a label key renders that literal string for English users (bit us once).
- **Design system (PR 5c):** `src/styles.css`'s `:root` is the token contract every view is
  styled against — `--bg0/1/2`, `--border(-strong)`, `--ink/-2/-3`, `--brass(-text)`,
  `--ok/--warn/--danger`, `--c1..--c5` (categorical, fixed order, never cycled). A
  `:root[data-theme="light"]` twin is authored but unwired. `src/Modal.tsx` (Radix Dialog),
  `src/InfoTip.tsx` (Radix Popover), and inline Radix `DropdownMenu`/`Popover`/`Toast` usage
  are the shared interactive primitives — see the Radix Dialog sibling-portal gotcha below
  before touching `.modal`/`.modal-backdrop`. `src/colors.ts` (`projectColorMap`) and
  `src/charts/ChartWrapper.tsx` (Recharts wrapper) are chart primitives.

## Patterns

- State lives on `globalThis` (`__chronicleLive` etc.) so Vite SSR module reloads don't
  orphan watchers/child processes.
- All secret-bearing API output goes through `maskService`-style masking; never return
  raw headers/env.
- Destructive or user-visible ops back up first under `~/.chronicle/backups/` and require
  an explicit UI click.
- UI is plain React + one `styles.css` (CSS variables, dark theme) — no UI framework;
  match that style. Charts are Recharts (via `ChartWrapper`) or hand-rolled SVG/CSS.
- Long lists: window around the selection (~400 rows) + decimate timeline ticks;
  don't render unbounded arrays (sessions reach 5k+ messages).
- **npm-publish checklist** (order matters): bump `package.json` version FIRST → commit +
  push (a branch + PR) → merge, return to `main` → confirm `main` green
  (`npm run typecheck && npm test && npm run build`) → `npm publish` (`prepublishOnly` gates
  on typecheck+test; `prepack` builds `dist/` + `dist-server/`) → verify
  `npm view chronicle-cli version` → clean-dir npx smoke (see npm / npx) → tag the bump
  commit `git tag vX.Y.Z <commit> && git push origin vX.Y.Z` → `gh release create vX.Y.Z`.
  Tag = `package.json` version = published version.
- **Branch + PR for non-trivial changes** (Chi's preference) — don't commit straight to
  `main`; make a `fix/…`/`feat/…` branch, push, `gh pr create`, even solo. Reserve
  direct-to-`main` for trivial/agreed one-offs. **After a PR merges, return the local
  checkout to `main`** (`git checkout main && git pull && git fetch --prune && git branch -D
  <branch>`) — see the git-pill gotcha below.
- **Squash-merge leaves stale head branches; they read as "not merged".** GitHub's squash
  merge rewrites the PR into ONE new commit on `main`, so the original branch's commits are
  NOT ancestors of `main` — `git merge-base --is-ancestor origin/<b> origin/main` returns
  false even though its content shipped. Before deleting, confirm the work landed via a
  MERGED PR (`gh pr list --state all --head <b>`), NOT `is-ancestor`. Then
  `git push origin --delete <b>`.
- **The docs site is a separate deployable.** `website/` (VitePress, EN-only, `srcDir: docs`,
  `base: '/docs/'`) serves getchronicle.dev/docs + a static landing at `/`, deployed to the
  `chronicle-web` Vercel project via `.github/workflows/deploy-docs.yml` on any push to
  `main` touching `docs/**`/`CHANGELOG.md`/`website/**` (secret: `VERCEL_TOKEN`). Edit
  `docs/`, never `website/docs/` (regenerated at build by `website/scripts/build-content.mjs`
  + `assemble.mjs`). The changelog page is GENERATED from repo-root `CHANGELOG.md`.

## Gotchas

- **Mount an express *app*, not a Router, into Vite middleware** — Router leaves
  `res.json` undefined on raw Node res objects.
- `vite.config.js` edits restart the dev server; the preview/curl port drops briefly.
- Merge commits show empty `diff-tree` without `-m --first-parent` (already handled).
- OpenCode/Cursor DBs are WAL — copying only the `.db` file yields an EMPTY database;
  always copy `-wal`/`-shm` too (parsers do).
- Claude Code JSONL: skip `<command-name>`/`<local-command` user strings and
  `<system-reminder>` text blocks, or imports fill with noise. (Sidechain/subagent entries
  are NOW imported deliberately — see the Subagents decision — not skipped.)
- `messages.seq` from live SSE starts at 1,000,000 to avoid colliding with stored seqs;
  live messages exist only in client state until re-import.
- Session import is `replaceSession` (delete + reinsert): re-import is idempotent, but
  live-only messages are unaffected by design.
- **`replaceSession` preserves the user-set `name`** across its delete+reinsert (reads
  `prev.name` first) — `summary`/`usage` are re-derived each import, but a Chronicle rename
  must survive re-sync. A stale process sharing `~/.chronicle/chronicle.db` that predates the
  `name` column will wipe titles on any sync — kill it before debugging "my rename vanished".
- `sessions.context_tokens` (real context size from Claude Code usage records) only
  populates on import — after upgrading, re-import or Sync Update, else session cards fall
  back to the ~chars/4 estimate.
- Per-session source-file deletion is restricted to sources where one file = one session
  (claude-code, codex); OpenCode/Cursor share one DB across sessions, so their files are
  never deleted.
- The tool-result error heuristic exists in multiple places: `ERROR_RE` in
  `server/routes/projects.ts` + `server/insights.ts` + `server/explore.ts`, and
  `isErrorResult` in `src/SessionView.tsx`. Change all or the Errors counts diverge.
- **Never use `window.prompt()`/`confirm()`/`alert()` for input in this app** — they are
  blocked (silently return null) in embedded/preview browser contexts, so the action
  no-ops with no error. Use an inline edit-in-place field / inline confirm bar instead
  (see `OverviewMode` in `SessionView.tsx` and the `HomePage` multi-select flow).
- **`.info-bubble` (InfoTip ⓘ) must open DOWNWARD.** `InfoTip` (`src/InfoTip.tsx`) uses
  Radix Popover with `side="bottom"` + `avoidCollisions={false}` — the
  `avoidCollisions={false}` is load-bearing, not optional: Radix's default collision-flip
  would otherwise flip it upward inside `.page` (`overflow-y: auto`, clips both axes) and
  cut it off at the viewport top. 250px wide so long explainers stay short.
- **Radix `Dialog.Overlay` and `Dialog.Content` render as PORTALED SIBLINGS, not nested.**
  `.modal`'s old centering relied on being a flex child of `.modal-backdrop`, which stopped
  working once Radix's Portal made Overlay and Content direct portal children. `.modal` now
  self-centers via its own `position:fixed; top/left:50%; transform:translate(-50%,-50%)` —
  and that transform must be a STATIC property on `.modal`, not only in the entrance
  keyframe's `to` state (`animation-fill-mode` defaults to `none`, so an animated-only
  transform reverts to `transform:none` when the 200ms `modal-in` finishes and the modal
  snaps to the top-left of its anchor). Caught only by clicking through the built app.
  Radix `Toast.Root` also defaults to a 5s `duration` — pass `duration={N}` explicitly if
  app logic (e.g. an undo window) assumes a different auto-dismiss time.
- The project-card **git pill shows the local checkout's live branch** — `repoInfo` in
  `server/git.ts` shells out to `git` on every `/api/projects` call (NO caching), so it's
  always accurate. If it shows a feature branch after a PR merged, the working tree is still
  ON that branch — switch back to `main` (the pill is right, the checkout is wrong).
- The repo has moved twice in the maintainer's home dir (2026-07-05, 2026-08-08). Each move
  changes the munged Claude Code transcript dir under `~/.claude/projects/`; old session
  JSONLs were migrated to the current munged path and internal `cwd` paths updated, so
  imported sessions stay valid.
- **The auto-mode safety classifier gates outward/irreversible steps** — Vercel prod
  deploys, `git push` to the default branch, `gh release` / `npm publish`, `rm` of things
  outside the repo. Explicit user authorization in the immediately preceding turn usually
  clears it; otherwise route via a PR or hand the exact command to the user. Never work
  around a denial.

## Verification habits used here

Features were verified against real data: this repo's own Claude Code session
(import → time travel → causality), `~/health-analyst` (234 commits), and fixture
DBs/JSON for Cursor/Codex/OpenCode-live in `test/fixtures/`. Prefer that over mocks: the
fastest end-to-end check is importing Chronicle's own session and clicking around. Known
deferrals: remote SSH (no host to test), Windows/Linux beyond the npx path.

## Records seam (AIOS hub)

Chronicle is a registered AIOS satellite (minimal: records seam only; no runtime hub reads yet). Its dev sessions and decisions flow into the hub.

- Decisions meeting the hub logging bar: top of `<hub>/records/decisions.md`, header ending `(session <id>, stream: chronicle)`. Hub = `$AIOS_HUB` or `~/chizhang-2`.
- Brainstorms: `<hub>/records/brainstorms/`.
- Session end: the registry-scoped Stop hook (hub `.claude/hooks/session-ledger.py`, wired in tracked `.claude/settings.json` per the hub template in `governance/satellite-repos.md`, CHI-115) appends this session's row to `<hub>/records/sessions_index.md` with `Repo = chronicle`. Focus lines and unlogged decisions are auto-swept after the session (CHI-148 sweeper); do not fill them manually. Decisions Chi confirms live are still best logged in-flow.
- Pre-push scan list: deferred until Chronicle reads hub data (CHI-107 decision). Chronicle never reads the hub today, so it cannot carry hub-confidential data. Standard push confirm-first still applies.
