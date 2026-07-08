# Chronicle — project notes for Claude

Local-first AI coding session manager ("time machine"): imports logs from 6 AI tools,
maps every message to a Git code snapshot, plus MCP Hub, Skills Hub, security
redaction, live streaming, replay, and an Electron shell. Spec: `docs/AI-session-manager-PRD.md`.
Feature inventory with FR-numbers: `README.md`.

## Commands

```bash
npm run dev        # Vite dev server + API in one process → http://localhost:4173
npm run desktop    # production build + Electron shell (port 41730, tray)
npm run standalone # headless production server (UI + /api + /share + /mcp)
npm run build      # vite build → dist/
npm run dist:mac   # electron-builder → unsigned arm64 + x64 DMGs in release/
npm run reinstall:mac # quit app, rebuild (arm64 only), replace /Applications/Chronicle.app, clean release/, relaunch
npm run dist:win   # NSIS .exe (cross-built from macOS; untested on real Windows)
npm run dist:linux # AppImage + .deb (untested on real Linux)
```

No test runner is wired up; parsers are validated against fixtures in `test/fixtures/`
plus real data end-to-end (see Verification below).

## Architecture decisions (and why)

- **Single process, single port.** The Express apps (`server/api.js`, `server/shares.js`,
  `server/mcp/hub.js`) are mounted INTO the Vite dev server via a plugin in
  `vite.config.js` using per-request `ssrLoadModule` (gives API hot-reload). The same
  apps are served without Vite by `server/standalone.js` (used by Electron). Keep new
  endpoints in these express apps and they work in all three run modes for free.
- **`node:sqlite` (DatabaseSync), not better-sqlite3** — zero native compile. DB at
  `~/.chronicle/chronicle.db` (override: `CHRONICLE_DATA_DIR`). Schema is created
  idempotently in module scope; migrations are `try { ALTER TABLE … } catch {}` lines.
- **Git snapshot engine shells out to `git`** (`server/git.js`) — read-only:
  `rev-list --before` (commit at timestamp), `ls-tree`, `show`, `diff-tree`. No libgit.
- **Normalized event model** — every parser flattens tool-native logs into rows of
  kind `user | assistant | thinking | tool_use | tool_result` with `ts`, `tool_name`,
  `tool_input` (JSON string), `tool_use_id` (pairs calls↔results). Add new sources as
  `server/parsers/<tool>.js` exporting `scan<Tool>Projects()` + a parse function, then
  wire into `/api/scan` + `/api/import` in `api.js` and `SOURCES` in `ImportWizard.jsx`.
- **Logical projects** key on the physical `cwd` recorded in logs; sources that don't
  record one (Gemini) get virtual paths (`gemini-project:<hash>`) and a
  "Needs association" banner that merges on path match.
- **Read-only on foreign data, always**: SQLite sources (Cursor, OpenCode) are copied
  to temp **including `-wal`/`-shm`** before opening; original logs are never written.
- **Everything heavy is heuristic + local** (causality confidence tiers, redaction
  regexes) — no LLM calls anywhere, preserving the offline guarantee.
- **Desktop = Electron** (`electron/main.mjs`), not Tauri — no Rust toolchain on this
  machine. The server layer has zero Electron imports, so a Tauri swap stays possible.
  Window close hides to tray (MCP Hub keepalive); quit only via tray menu.
- **Repo is flat** (Chi's global preference): app code at root, PRD in `docs/`.
- **Global sidebar owns navigation; SessionView registers its modes into it.**
  There is one collapsible left sidebar (in `App.jsx`): Projects +
  sync-all on top, MCP Hub/Skills/Security/Feedback/Collapse pinned at bottom.
  SessionView doesn't render its own rail — it publishes `{modes, active, select,
  securityOpen}` up via the `onRailChange` prop while mounted; App renders those as
  sidebar items. SessionView is keyed by session id so the breadcrumb session
  switcher remounts it cleanly.
- **Latest `cwd` wins when resolving a session's project.** Sessions resumed after a
  repo move keep the old path in early JSONL records; scanner and parser use the last
  seen cwd (where the repo and its Git history live now) and collapse subdirectory
  cwds up to a seen ancestor (`reduceCwd`). The scanner sniffs both the head and tail
  64 KB of each file for this.
- **Packaging keeps the runtime dependency set minimal.** Vite bundles all client
  libs into `dist/`, so `react`/`react-dom`/`diff` live in devDependencies — only
  `express` is a runtime dep that electron-builder ships. Electron locales are
  stripped to en + zh_CN; arch selection lives in CLI flags (not build config) so
  `dist:mac` builds both arches while `reinstall:mac` builds only arm64. The
  ~100 MB DMG floor is the Electron framework itself; a ~26 MB footprint
  would require the Tauri swap.
- **Feedback is the one deliberate outbound network feature** (besides the update
  check and GitHub skill imports): `POST /api/feedback` relays to email via
  formsubmit.co, always appends to `~/.chronicle/feedback.log` first, and the UI
  falls back to a `mailto:` link when the relay is unreachable.
- **Session display name = `name` (Chronicle override) → `summary` (parsed) →
  `first_prompt`.** `sessionDisplayName()` in `ProjectDetail.jsx` is the single
  source of that precedence; reuse it everywhere (rows, pickers, overview title).
  The parser reads Claude Code's `{"type":"custom-title","customTitle":…}` lines
  (the `/rename` title, LAST one wins) into `sessions.summary`; there are NO
  `type:"summary"` lines in real logs, so custom-title is the only auto-title
  source. `name` is a user-set override, preserved across re-import (see below).
- **Cost is computed locally, never billed data.** Logs carry tokens, not dollars,
  so the parser aggregates per-model token totals (`sessions.usage` JSON:
  `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`) and
  `src/models.js` multiplies by a static per-model price table. 5-minute and
  1-hour cache writes are billed at different rates — keep them split. The table
  must track the current Anthropic pricing page (Opus 4.8 tier is $5/$25, NOT the
  old Opus 4.1 $15/$75 — getting this wrong 3× inflates every number).
- **Global search is LIKE-based, not FTS.** `/api/search` scans `messages.text` +
  `tool_input` with `LIKE`, grouped per session (top ~40) with a snippet; empty
  query returns recent sessions ("Recent Access"). Fine at this scale (~15k rows);
  revisit with FTS5 only if it gets slow.

## Key files

- `server/db.js` — schema (projects/sessions/messages) + `replaceSession` transaction
- `server/api.js` — ALL REST routes; also installs the skills fs-watcher on load
- `server/git.js` — snapshot engine; `commitsBetween` pads ±10 min for timeline ticks
- `server/parsers/` — claudeCode, codex, cursor, opencode, gemini, copilot
- `server/live.js` — JSONL tail (`Watcher`) + SQLite poll (`SqlitePollWatcher`) → SSE
- `server/replay.js` — replay plan/sandbox/step execution (`~/.chronicle/replay/<id>/`)
- `server/causality.js` — read→change linking, confidence 0.95/0.55/0.5/0.45/0.2
- `server/security.js` — redaction rules, `scanSession`, `preToolUseCheck`, interceptions
- `server/shares.js` — share tokens + the public `/share/:token` HTML page
- `server/skills.js` — central store `~/.chronicle/skills/`, symlink fanout, GitHub
  import, snapshot history (`~/.chronicle/snapshots/`)
- `server/mcp/{registry,hub}.js` — service registry (+policies/scoping/credentials),
  Streamable-HTTP aggregator at `/mcp`
- `hooks/chronicle-guard.mjs` — Claude Code PreToolUse hook (exit 2 = block, fails open)
- `src/App.jsx` — global sidebar (collapse state in localStorage, sync-all loop,
  feedback modal), view routing, LIVE pill, project-card gear menus
- `src/SessionView.jsx` — the core session view; registers modes
  (overview/playback/refine/replay + security check, ⌘1–⌘4) into the sidebar via
  `onRailChange`; owns filtering, windowing, live SSE, causality panels, the
  breadcrumb session switcher, and the Overview stats page (context-window bar,
  copyable session ID, deletion danger zone)
- `src/ProjectDetail.jsx` — project analytics home (8 stat cards, line/bar trend,
  source donut, call ranking; time range via `/api/projects/:id?days=N`)
- `src/models.js` — static per-model tables (never fetched): context windows +
  list-price table (`pricingFor`, `costOf`, `costBreakdownOf`, `cacheWriteTokens`).
  Update when new models ship or prices change.
- `src/i18n.js` — `t()` looks up `DICTS[lang()]` (zh + ja dicts, English is the
  key itself); language dropdown reloads the page. Add a locale = add a dict here.
- `src/ProjectDetail.jsx` — also exports `sessionDisplayName()`, `ProjectPicker`,
  `SessionPicker`; the `days` for "Today" is fractional-days-since-local-midnight,
  memoized on `range` (recomputing per render would loop `Date.now()` refetches).
- `server/api.js` search/rename/sync routes: `GET /api/search`, `PATCH
  /api/sessions/:id` (rename), `POST /api/sessions/:id/sync` (single-session).
- `packaging/homebrew/` — the cask + tap README published to the PUBLIC
  `chizhangucb/homebrew-chronicle` tap, which hosts the cask DMGs; the update feed
  and README DMG link point at the tap. (The `chronicle` repo is also public now.)

## Patterns

- State lives on `globalThis` (`__chronicleLive`, `__chronicleHub`, `__chronicleSkillWatch`)
  so Vite SSR module reloads don't orphan watchers/child processes.
- All secret-bearing API output goes through `maskService`-style masking; never return
  raw headers/env.
- Destructive or user-visible ops (hook install, restores, takeovers) back up first
  under `~/.chronicle/backups/` and require an explicit UI click.
- UI is plain React + one `styles.css` (CSS variables, dark theme) — no UI framework;
  match that style.
- Long lists: window around the selection (~400 rows) + decimate timeline ticks;
  don't render unbounded arrays (sessions reach 5k+ messages).
- **Release checklist** (order matters): bump `package.json` version FIRST →
  `npm run dist:mac` → `shasum -a 256 release/*.dmg` → update
  `packaging/homebrew/Casks/chronicle.rb` (version + both shas) → commit + push →
  `gh release create vX.Y.Z --notes-file …` → `gh release upload vX.Y.Z *.dmg`
  (separately from create: 234 MB uploads exceed 5-min foreground timeouts) →
  reinstall locally (`ditto release/mac-arm64/Chronicle.app /Applications/…`) →
  `rm -rf release`. Tag must land on the bump commit so tag = package version = DMGs
  = cask shas.
- Charts are hand-rolled SVG/CSS (polyline + conic-gradient donuts) — no chart
  library; keep it that way.

## Gotchas

- **Mount an express *app*, not a Router, into Vite middleware** — Router leaves
  `res.json` undefined on raw Node res objects.
- `vite.config.js` edits restart the dev server; the preview/curl port drops briefly.
- Merge commits show empty `diff-tree` without `-m --first-parent` (already handled).
- OpenCode/Cursor DBs are WAL — copying only the `.db` file yields an EMPTY database;
  always copy `-wal`/`-shm` too (parsers do).
- Claude Code JSONL: skip `isSidechain` entries, `<command-name>`/`<local-command`
  user strings, and `<system-reminder>` text blocks, or imports fill with noise.
- `messages.seq` from live SSE starts at 1,000,000 to avoid colliding with stored seqs;
  live messages exist only in client state until re-import.
- Replay auto-play must SKIP command steps and out-of-project writes (mark `skipped`),
  never hard-pause on them — pausing made the button look broken (fixed once already).
- The pre-tool-use hook, once installed in `~/.claude/settings.json`, genuinely blocks
  Claude Code tool calls containing seeded secrets — including Chronicle's own dev
  sessions (test fixtures contain fake keys). It is NOT currently installed.
- Session import is `replaceSession` (delete + reinsert): re-import is idempotent, but
  live-only messages and share `content` frozen at creation are unaffected by design.
- The repo moved from `/Users/chizhang/personal /ai-session-manager` (trailing space!)
  to `/Users/chizhang/personal/ai-session-manager` on 2026-07-05. Old Claude Code
  session JSONLs still live under the old munged dir
  `~/.claude/projects/-Users-chizhang-personal--ai-session-manager/` — Chronicle's
  imported sessions point there and stay valid. New sessions land in
  `-Users-chizhang-personal-ai-session-manager` (memory was migrated there).
- Update feed in `electron/main.mjs` points at the PUBLIC `chizhangucb/homebrew-chronicle`
  tap (which hosts the public release DMGs for the cask). The
  updater does a plain `latest !== current` string compare, so `package.json`
  version MUST equal the release tag (minus the `v`) or users get bogus update
  prompts (env override: `CHRONICLE_UPDATE_FEED`). Each release therefore needs a
  matching release+DMGs on BOTH repos (chronicle for the record, the tap for
  public download); the release checklist already uploads to the tap.
- **Never use `window.prompt()`/`confirm()`/`alert()` for input in this app** — they
  are blocked (silently return null) in embedded/preview browser contexts, so the
  action no-ops with no error. The session rename learned this the hard way; use an
  inline edit-in-place field instead (see `OverviewMode` in `SessionView.jsx`).
- **`replaceSession` preserves the user-set `name`** across its delete+reinsert
  (reads `prev.name` first) — `summary`/`usage` are re-derived each import, but a
  Chronicle rename must survive re-sync. An OLD build sharing `~/.chronicle/chronicle.db`
  (e.g. a stale packaged app on 41730) does NOT know the `name` column and will
  wipe titles on any sync — quit it (`pkill -f Chronicle.app`) before debugging
  "my rename vanished".
- `sessions.context_tokens` (real context size from Claude Code usage records) only
  populates on import — after upgrading, re-import or Sync Update, else session cards
  fall back to the ~chars/4 estimate.
- Per-session source-file deletion is restricted to sources where one file = one
  session (claude-code, codex, copilot); OpenCode/Cursor share one DB across
  sessions, so their files are never deleted.
- Packaging (`npm run dist:mac`) uses `asar: false` — the server resolves `dist/`
  and parsers as plain files via `import.meta.url`; enabling asar breaks those paths.
  Homebrew cask lives in `packaging/homebrew/` and is published to the
  `chizhangucb/homebrew-chronicle` tap with DMGs attached to that repo's releases.
- **New client-side npm deps go in devDependencies**, not dependencies — Vite bundles
  them into `dist/`, and electron-builder ships everything in `dependencies` inside
  the app (a misplaced client lib silently fattens every DMG). Only genuine
  server-runtime deps (express) belong in `dependencies`.
- electron-builder 26 rejects `dmg.format: "ULMO"` — ULFO (lzfse) is the strongest
  supported DMG compression.
- `gh release upload` sometimes fails with `dial tcp: lookup uploads.github.com: no
  such host` — a transient resolver hiccup, not sandbox/network policy; just retry
  (with `--clobber`). Create the release first, upload assets as a separate step.
- Only one Chronicle can run per machine (single-instance lock + port 41730): a
  freshly launched app exits silently (code 0, no output) if any instance — dev
  `electron .`, packaged, or a stale `standalone.js` — already holds the lock or
  port. `pkill -f "Chronicle.app/Contents/MacOS/Chronicle"` before launching a new
  build; check `lsof -iTCP:41730` when the UI 404s unexpectedly (a stale server from
  a deleted directory once served broken pages here).
- The tool-result error heuristic exists twice: `ERROR_RE` in `server/api.js`
  (project analytics) and `isErrorResult` in `src/SessionView.jsx` (Overview).
  Change both or the Errors counts diverge.
- The feedback relay (formsubmit.co) has three requirements, all learned the hard
  way: (1) it **returns HTTP 200 even on failure** — the real outcome is
  `body.success` (`"true"`/`"false"`), so `/api/feedback` must parse the body, not
  just check `r.ok`, or it falsely reports "sent" and suppresses the mailto
  fallback; (2) the server-side fetch must send an `Origin`/`Referer` header or
  formsubmit rejects it with "open this page through a web server"; (3) it requires
  a **one-time activation click** on a confirmation email sent to `FEEDBACK_EMAIL`
  (`chizhangucb@gmail.com`) on first submission — until clicked, NO email is
  delivered and submissions only land in `~/.chronicle/feedback.log`. The
  connected Gmail MCP is `chi.zhang@gokite.ai`, a different inbox, so the gmail
  activation can't be automated from here.
- `release/` is disposable and gitignored: `mac/` (x64) and `mac-arm64/` are
  electron-builder staging dirs the DMGs are packed from; the `.yml`/`.blockmap`
  files are for electron-builder's own updater, which Chronicle doesn't use.

## Verification habits used here

Features were verified against real data: this repo's own Claude Code session
(import → time travel → causality → replay of its own construction),
`~/health-analyst` (234 commits), the live `anthropics/skills` repo (GitHub import),
and fixture DBs/JSON for Cursor/Codex/Gemini/Copilot/OpenCode-live. Prefer that over
mocks: the fastest end-to-end check is importing Chronicle's own session and clicking
around. Known deferrals: remote SSH (no host to test), OAuth browser flow, destructive
skills takeover, signed auto-update.
