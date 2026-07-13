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
- **Top-bar actions (Search + Import) are global, not Home-only.** The `.topbar-right`
  🔍 Search and "+ Import Sessions" buttons render in EVERY view alongside the language
  switcher (they used to be gated on `view.name === 'home'`); import/search work from
  anywhere and refresh projects. Only the LIVE pill stays session-scoped.
- **Home multi-select delete uses an inline confirm, never `window.confirm`.** `HomePage`
  has a "Select" mode: cards become checkboxes (`selectMode`/`selected` Set), with
  Select-all/Clear/Cancel + a danger "Remove (N)". Deletion is a two-step INLINE confirm
  bar in the title row (`confirming` state) — NOT `window.confirm`, which is blocked in
  embedded/preview browsers (same gotcha as the rename). It loops `api.deleteProject` (same
  "Remove from Chronicle", source logs untouched) then refreshes. The per-card gear
  `ProjectMenu` is hidden while in select mode.
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
  check and GitHub skill imports): `POST /api/feedback` forwards to a **hosted
  relay** (`feedback-relay/`, a Vercel function holding the Resend key server-side),
  always appends to `~/.chronicle/feedback.log` first, and the UI falls back to a
  `mailto:` link when the relay fails. **No secret ships in the app** — it posts to
  the public relay URL (`DEFAULT_FEEDBACK_RELAY` in `api.js`; override via
  `CHRONICLE_FEEDBACK_RELAY` or `feedbackRelay` in `~/.chronicle/config.json`), so
  feedback works from every user's machine, not just the maintainer's. This is a
  SECOND deployable, so the repo now has a `feedback-relay/` subdir (Vercel project
  `feedback-relay`, key + `FEEDBACK_TO`/`FEEDBACK_FROM` set as env vars there).
  **getchronicle.dev migration (2026-07-09):** relay lives at the branded
  `relay.getchronicle.dev` (Vercel custom domain; `DEFAULT_FEEDBACK_RELAY` in `api.js`).
  Flow: app → relay → Resend sends **to `feedback@getchronicle.dev`** → **Porkbun
  email forwarding** → the maintainer's personal inbox. The personal gmail lives ONLY
  in Porkbun's forwarding rule — never in code, the bundle, Resend, or Vercel (git
  author is also the GitHub noreply). `getchronicle.dev` is a Resend **Pro** domain
  (free plan caps at 1 domain; it already had `healthverse.dev`), DKIM+SPF verified.
  Actual sender is set via the Vercel env `FEEDBACK_FROM` (kept out of the public
  repo); the code default stays `feedback@getchronicle.dev`. The legacy
  `*.vercel.app` relay URL still works for already-shipped apps (the URL change only
  affects new builds). **Sender identity (v0.1.7):** the feedback modal has an
  optional email field; the local server embeds it in the message body (`↩ Reply to:
  …`, so it's visible even on an older relay) AND passes `email` so the relay sets the
  email's `Reply-To` (+ a "from <email>" subject). The relay does NOT also append its
  own body line — that would duplicate the local embed. Deploy the relay from `main`
  after merge (see the multi-worktree gotcha).
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
  old Opus 4.1 $15/$75 — getting this wrong 3× inflates every number). The Overview
  Cost & Usage block DISPLAYS the two tiers separately too (tokens + $), each with a
  `5m`/`1h` `.ttl-tag`: `cacheWriteByTtl()` / `cacheWriteCostByTtl()` in `models.js`
  split them (legacy `{cacheWrite}` logs are treated as 5m). The `1h` row only renders
  when 1h writes exist; a session can be entirely 1h-cached (v0.1.8 test session was).
- **Global search is LIKE-based, not FTS.** `/api/search` scans `messages.text` +
  `tool_input` with `LIKE`, grouped per session (top ~40) with a snippet; empty
  query returns recent sessions ("Recent Access"). Fine at this scale (~15k rows);
  revisit with FTS5 only if it gets slow.
- **Chat-type labels have ONE source of truth: `src/kinds.js`.** `KIND_LABEL`/`KIND_ICON`
  (role-accurate: User / Assistant / Thinking / Tool Call / Tool Result / Inserted) are
  imported by Playback (`SessionView` `KIND_META`), Refine (`RefineMode`, uppercased for
  its tag look), and the Refine export. They used to drift (Playback said "You"/"AI",
  Refine said "USER"/"ASSISTANT"); put new label wording here, never inline.
- **"Agent Active" (labeled thus, was "Active Duration") = agent working time, excluding
  only real human turns.** `activeDurationMs()` in `SessionView` sums every inter-message
  gap EXCEPT the gap leading into a genuine human prompt. The catch: **not every `user`-role
  message is a human prompt** — `<task-notification>` (a background build finishing),
  `<launch-selected-element>` (UI element pick), `<system-reminder>`, `<command-name>`/
  `<local-command…>`, and `[Request interrupted…]` all log with role=user. `isHumanPrompt()`
  filters those via `SYNTHETIC_USER_RE`, so their preceding gap counts as ACTIVE (the agent
  was busy, e.g. building; or you were interacting with the app) — only a typed prompt
  subtracts time. All assistant-thinking + tool-execution gaps count in FULL, no cap.
  History: v0.1.7 used an `IDLE_GAP_MS` 5-min cutoff (dropped long tool runs); v0.1.9
  switched to human-gap exclusion but counted EVERY role=user as human, which charged
  background-build waits to your idle time (a real session read 33m Active / 59m Total, ~10m
  of it a notarize-build wait); the classifier fix reclaimed that (→43m). Shown with an
  `InfoTip` (ⓘ) explainer; if you reword it, its key IS the full English sentence — update
  the zh + ja dicts too. `src/kinds.js` still labels the message kinds; the STAT-CARD label
  is `t('Agent Active')`.
- **Language switch keeps your place.** `setLang` still `location.reload()`s — many `t()`
  calls run at module scope (e.g. `FILTER_CHIPS`), so a full reload is the only clean
  re-translate. To stop landing back on Home, `App` persists the current `view` in
  `sessionStorage` and restores it on mount.
- **The public site is ONE Vercel deployable serving two things.** `website/` (a THIRD
  deployable, after the app and `feedback-relay/`) serves the static **download landing
  page** (`website/index.html`) at `/` AND a **VitePress docs site** at `/docs`, combined
  into one `dist/` at build time (`website/scripts/assemble.mjs`) and deployed to
  **getchronicle.dev** via the **`chronicle-web`** Vercel project. The docs render the
  canonical `docs/` Markdown (VitePress `base: '/docs/'`, `srcDir: 'docs'`); `docs/` stays
  the single source of truth. **Edit `docs/`, never `website/docs/`** (generated at build).
- **`docs/` is the layered developer documentation** (guide / reference / architecture,
  ~28 pages + `index.md`/`contributing.md` + a generated `changelog.md`), published at
  getchronicle.dev/docs. **Quickstart is the first page** (leads with download + install + a
  `<Walkthrough/>` demo). `superpowers/` (brainstorming specs/plans) and the PRD are EXCLUDED
  from the public site. The feature inventory in `README.md` is now a short categorized summary
  linking to the docs.
- **The docs are trilingual (EN · 简体中文 · 日本語), matching the product UI.** VitePress i18n
  via `locales` in `website/.vitepress/config.mjs`: English is the root (`/docs`, content
  `docs/*`), Chinese is `docs/zh/**` (`/docs/zh`), Japanese is `docs/ja/**` (`/docs/ja`) — each
  with translated nav/sidebar labels + UI strings and a language switcher. **English is the
  source of truth; `docs/zh` + `docs/ja` are committed translations that DRIFT until
  re-translated** when an English page changes (re-translate `docs/<lang>/<same-path>.md`;
  keep code/paths/links/product names verbatim). Every page exists in all three locales so
  relative links resolve within a locale (VitePress fails the build on any dead link).

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
  feedback modal), view routing, LIVE pill, always-on top-bar Search/Import, project-card
  gear menus, and the `HomePage` multi-select delete flow
- `src/SessionView.jsx` — the core session view; registers modes
  (overview/playback/refine/replay + security check, ⌘1–⌘4) into the sidebar via
  `onRailChange`; owns filtering, windowing, live SSE, causality panels, the
  breadcrumb session switcher, the `⇧⌘U` per-session sync shortcut, and the Overview
  stats page (Total + Active Duration with an `InfoTip`, context-window bar,
  copyable session ID, deletion danger zone)
- `src/ProjectDetail.jsx` — project analytics home (8 stat cards, line/bar trend,
  source donut, call ranking; time range via `/api/projects/:id?days=N`)
- `src/models.js` — static per-model tables (never fetched): context windows +
  list-price table (`pricingFor`, `costOf`, `costBreakdownOf`, `cacheWriteTokens`,
  `cacheWriteByTtl`, `cacheWriteCostByTtl` — the last two split 5m/1h for display).
  Update when new models ship or prices change.
- `src/kinds.js` — the canonical `KIND_LABEL`/`KIND_ICON` maps (see the labels
  architecture decision); imported by `SessionView` (Playback) and `RefineMode`.
- `src/i18n.js` — `t()` looks up `DICTS[lang()]` (zh + ja dicts, English is the
  key itself); `setLang` reloads the page (App restores the `view` from
  `sessionStorage` so you stay put). Add a locale = add a dict here. **Because English
  IS the key, a long explainer's key must BE the full English sentence, not a short
  label** — using a label key (`'Active Duration explainer'`) renders that literal
  string for English users (bit us once).
- `src/ProjectDetail.jsx` — also exports `sessionDisplayName()`, `ProjectPicker`,
  `SessionPicker`; the `days` for "Today" is fractional-days-since-local-midnight,
  memoized on `range` (recomputing per render would loop `Date.now()` refetches).
- `server/api.js` search/rename/sync routes: `GET /api/search`, `PATCH
  /api/sessions/:id` (rename), `POST /api/sessions/:id/sync` (single-session).
- `packaging/homebrew/` — the cask + tap README published to the PUBLIC
  `chizhangucb/homebrew-chronicle` tap, which hosts the cask DMGs; the update feed
  and README DMG link point at the tap. (The `chronicle` repo is also public now.)
- `website/` — the **getchronicle.dev site** (THIRD deployable, after the app and
  `feedback-relay/`), ONE Vercel project (`chronicle-web`) serving two halves:
  - `/` — the static **download landing** (`website/index.html`, inline CSS/JS, light+dark).
    Fetches the latest release from the GitHub API at load (falls back to a hardcoded release
    + a built-in HTML mock if the API/screenshot is missing), so **new releases surface with
    no page change**. DMG links → the tap; source links → the repo.
  - `/docs` — the **VitePress docs** built from `docs/`. `website/.vitepress/config.mjs`
    (`base: '/docs/'`, `srcDir: 'docs'`, `locales` for en/zh/ja + nav/sidebar per locale),
    `website/.vitepress/theme/` (custom theme registering the `<Walkthrough/>` component),
    `website/scripts/build-content.mjs` (copies `../docs` → `website/docs`, excludes
    `superpowers/` + PRD, rewrites outside-`docs/` links to GitHub, **and generates
    `changelog.md` from repo-root `CHANGELOG.md`**), `website/scripts/assemble.mjs` (combines
    the VitePress build under `dist/docs` with the landing at `dist/` root). `website/README.md`
    is the deploy runbook (incl. the translation-upkeep note).
  Deploy: `cd website && npm run deploy[:preview]` (from `main` after merge). Preview the
  landing alone: `python3 -m http.server 4321 --directory website` (launch config `website`);
  the docs dev server is launch config `docs-dev` (`npm run docs:dev`, base `/docs/`).
- `docs/` — the layered developer docs (guide / reference / architecture, ~28 pages +
  `index.md`/`contributing.md` + a generated `changelog.md`); the single source of truth the
  website renders, in three locales: English at `docs/*`, `docs/zh/**` (简体中文), `docs/ja/**`
  (日本語). **Quickstart is the first page.** All internal links relative; VitePress validates
  them at build (a dead link fails the build), so no separate link-checker is needed.
- `website/.vitepress/theme/components/Walkthrough.vue` — the self-contained, CSS-only animated
  ~24s product demo embedded at the top of the Quickstart (message list → code rewinds → diff →
  timeline scrub). Captions localize by `useData().lang` (en/zh/ja); respects
  `prefers-reduced-motion`. Pure CSS keyframes — no external hosting, no JS timers to leak.

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
  = cask shas. Auto-update needs the zip + latest-mac.yml + blockmap on the tap release too:
  `gh release upload vX.Y.Z release/*.dmg release/*.zip release/latest-mac.yml release/*.blockmap`.
  **Signed builds** need the signing keychain + notary env (see the signing gotcha):
  `security unlock-keychain -p "$(cat ~/apple-signing/keychain-password.txt)"
  ~/apple-signing/chronicle-sign.keychain-db` then run `dist:mac` with
  `CSC_KEYCHAIN=~/apple-signing/chronicle-sign.keychain-db` (NOT `CSC_LINK`),
  `APPLE_API_KEY=~/apple-signing/AuthKey_M2G8W47DPN.p8`, `APPLE_API_KEY_ID=M2G8W47DPN`,
  `APPLE_API_ISSUER=2745be46-…`, `APPLE_TEAM_ID=9W7B6USGG9`. Verify before uploading:
  `spctl -a -vvv <app>` → "accepted / source=Notarized Developer ID" and
  `xcrun stapler validate <app>`. v0.1.6 was the first signed release; existing
  UNSIGNED users (≤0.1.5) upgrade once manually, then auto-update takes over.
  **Docs site: now auto-deploys.** The app release updates `CHANGELOG.md`, and a
  push to `main` touching `docs/**`, `CHANGELOG.md`, or `website/**` triggers
  `.github/workflows/deploy-docs.yml`, which regenerates content and deploys the
  `chronicle-web` Vercel project (needs the `VERCEL_TOKEN` repo secret; org/project
  IDs are inlined). So the changelog page updates on its own now — no manual
  `cd website && npm run deploy` (still the fallback / `workflow_dispatch`). BUT
  still add the release's entry to the zh + ja changelog TRANSLATIONS FIRST
  (`docs/zh/changelog.md`, `docs/ja/changelog.md` — committed files the site
  renders; `build-content.mjs` only regenerates the EN changelog from repo-root
  `CHANGELOG.md`), else those locales drift (they sat at v0.1.8 through the v0.1.9 +
  v0.1.10 app releases until caught up). Verify live after the Action runs:
  `curl -sL getchronicle.dev/docs/changelog.html | grep vX.Y.Z`.
- Charts are hand-rolled SVG/CSS (polyline + conic-gradient donuts) — no chart
  library; keep it that way.
- **Branch + PR for non-trivial changes** (Chi's preference) — don't commit straight
  to `main`; make a `fix/…`/`feat/…` branch, push, `gh pr create`, even solo. Reserve
  direct-to-`main` for trivial/agreed one-offs. **After a PR merges, return the local
  checkout to `main`** (`git checkout main && git pull && git fetch --prune && git
  branch -D <branch>`) — see the git-pill gotcha below.
- **Multi-worktree: singletons collide in the external resource, not in git.** When two
  worktrees/branches both touch a singleton — the Vercel relay, `package.json` version, the
  release tag, the Homebrew cask — git may merge cleanly while the *deployed* thing
  diverges. Deploy/publish those from `main` AFTER merge, never from a feature branch. (This
  session: two branches both edited `feedback-relay/api/feedback.js` → small "keep both"
  rebase conflicts, and an early relay deploy from a feature branch was later superseded by
  the deploy from `main`.)
- **Publishing the docs site.** `cd website && npm run deploy` = generate docs content locally
  (`npm run content` → `website/docs`), upload `website/`, and Vercel runs `npm run build:site`
  (`vitepress build` + `assemble.mjs`). Deploy from `main` after merge; the live project is
  `chronicle-web`. Docs content lives in `docs/` — editing `website/docs/` is pointless (it's
  regenerated on every build).
- **Trilingual docs upkeep.** English (`docs/*` + the generated `changelog.md`) is the source of
  truth; `docs/zh/**` + `docs/ja/**` are committed translations. When you edit an English page,
  re-translate its `zh`/`ja` counterpart (`docs/<lang>/<same-path>.md`) or it drifts — keep code,
  paths, links, and product names verbatim, translate only prose/headings/table text. The initial
  pass used parallel translation subagents (one per locale × section). New English page = add its
  `zh`/`ja` twin too, or the locale's relative links 404 and the build fails.

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
- Update feed = electron-updater reading the PUBLIC `chizhangucb/homebrew-chronicle`
  tap releases (baked into `app-update.yml` from `build.publish` in `package.json`,
  NOT hardcoded in `electron/main.mjs`); the tap also hosts the cask DMGs.
  electron-updater does a semver compare and installs only when the running app and
  the update share a Developer ID signature, so `package.json` version MUST equal the
  release tag (minus the `v`) and the release must carry the `.zip` + `latest-mac.yml`
  + `.blockmap` (see the release checklist). Each release still needs a matching
  release on BOTH repos (chronicle for the record, the tap for public download + the
  update feed).
- **Never use `window.prompt()`/`confirm()`/`alert()` for input in this app** — they
  are blocked (silently return null) in embedded/preview browser contexts, so the
  action no-ops with no error. The session rename learned this the hard way; use an
  inline edit-in-place field instead (see `OverviewMode` in `SessionView.jsx`).
  `ProjectMenu`'s gear still uses `prompt`/`confirm`/`alert`; the Home multi-select flow
  is the confirm-free path (an inline confirm bar) — prefer that pattern for new UI.
- **`.info-bubble` (InfoTip ⓘ) must open DOWNWARD** (`top: calc(100% + 8px)`, arrow on
  top). The Overview stats row sits at the top of `.page`, which is `overflow-y: auto`
  (and thus clips both axes) — an upward bubble got cut off at the viewport top and the
  text was unreadable. It's 300px wide so long explainers stay short; every InfoTip shares
  this one rule.
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
- **Not every tag ships an app binary — and the download page reads the TAP repo.**
  A docs/website-only release (v0.1.4, v0.1.8) has NO DMGs, so the cask, `latest-mac.yml`,
  and installed apps stay pinned to the last REAL app release (v0.1.8 shipped nothing →
  everything sat at 0.1.7 until v0.1.9). The getchronicle.dev landing fetches
  `api.github.com/repos/chizhangucb/homebrew-chronicle/releases/latest` (the **tap**, not
  the `chronicle` repo), so the tap release must carry the DMGs AND be marked Latest. Split
  per the v0.1.7/v0.1.9 pattern: the **`chronicle` repo** release carries just the 2 DMGs
  "for the record"; the **tap** release carries the full auto-update set (2 DMGs + 2
  blockmaps + 2 zips + 2 zip-blockmaps + `latest-mac.yml`). v0.1.9 (0.1.7→0.1.9, skipping
  the binary-less 0.1.8) was the first confirmed over-the-air update — the "Relaunch to
  apply" toast works end-to-end when both apps share the `9W7B6USGG9` Developer ID.
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
- Feedback email flows app → **hosted relay** (`feedback-relay/` on Vercel) →
  **Resend** → inbox, switched from formsubmit.co on 2026-07-07 (formsubmit's free
  tier returned `success:true` but Gmail silently dropped the mail; it also needed a
  per-address activation click + an `Origin` header). The relay exists because
  Chronicle is local-first: each user's app sends from THEIR machine, so a Resend
  key in a local file only works for the maintainer — the relay holds the key
  server-side so feedback works from every install. **New Vercel projects default to
  Deployment Protection (SSO) ON** → the relay 401s until you disable it
  (`PATCH /v9/projects/<name>` `ssoProtection:null`, or dashboard → Settings →
  Deployment Protection). The relay's branded URL is now `relay.getchronicle.dev`
  (Vercel custom domain → `DEFAULT_FEEDBACK_RELAY`); the legacy
  `feedback-relay-chizhangucb-projects.vercel.app` alias still serves already-shipped
  apps (the deploy-hash URL changes each deploy — never use it). Set
  `RESEND_API_KEY`/`FEEDBACK_TO`/`FEEDBACK_FROM` as Vercel env vars and REDEPLOY
  (`cd feedback-relay && vercel --prod`, authed as chizhangucb) for changes to take
  effect. `getchronicle.dev` is DKIM+SPF-verified in Resend (Pro plan), so `FEEDBACK_FROM`
  sends from it; `onboarding@resend.dev` only reaches the Resend account owner.
  **Porkbun gotcha:** its Cloudflare-embedded DNS console frequently hangs in browser
  automation ("Page still loading"/never idle) and the extension blocks reading
  base64 (DKIM) values — paste DNS records manually; `vercel --prod` + `dig` were the
  reliable verification paths.
- `npm run reinstall:mac` rebuilds the bundle but its `pkill; …; open` **does not
  reliably relaunch the new code**: closing the window only hides the app to the
  tray, so `pkill` often fails to kill it, the old process keeps port 41730 (single-
  instance lock), and the new binary exits on launch. The still-running process
  serves the OLD server code from memory (it loaded `server/*.js` at startup;
  replacing files on disk doesn't touch it). After `reinstall:mac`, VERIFY the
  restart — `ps -o lstart= -p $(lsof -tiTCP:41730)` must be AFTER the rebuild;
  if not, quit via the tray menu (or `pkill`) and `open -a Chronicle`.
- The project-card **git pill shows the local checkout's live branch** — `repoInfo`
  in `server/git.js` shells out to `git` on every `/api/projects` call (NO caching),
  so it's always accurate, not stale. If it shows a feature branch after a PR merged,
  that's because the working tree is still ON that branch — switch back to `main`
  (the pill is right, the checkout is wrong). Bit us twice; see the branch/PR pattern.
- `release/` is disposable and gitignored: `mac/` (x64) and `mac-arm64/` are
  electron-builder staging dirs the DMGs are packed from; the `.yml`/`.blockmap`
  files are for electron-builder's own updater, which Chronicle doesn't use.
- **Signing is guarded.** `build/notarize.cjs` (afterSign hook) notarizes only when
  `APPLE_*` creds are in env; `build.mac` has no `identity`, so electron-builder signs
  when a Developer ID cert is present and produces an UNSIGNED build otherwise. Do NOT
  re-add `identity: null` (hard-disables signing). `npm run dist:mac` must stay green
  with no Apple creds.
- **macOS signing needs a DEDICATED keychain, NOT `CSC_LINK`** (the v0.1.6 lesson, cost
  ~5 build attempts). electron-builder's default `CSC_LINK=<p12>` imports the cert into
  a throwaway TEMP keychain whose `codesign --keychain <temp>` can't reach the system
  Apple Root → `codesign … errSecInternalComponent` + "unable to build chain to
  self-signed root" (it also drops any intermediate/root bundled in the `.p12`).
  **FIX** (all creds live in `~/apple-signing/`, OUTSIDE the repo): (1) build a `.p12`
  with the FULL chain — leaf → `Developer ID Certification Authority` (G2, from
  apple.com/certificateauthority) → `Apple Root CA` (apple.com/appleca) + private key;
  (2) `security create-keychain -p <kcpw> chronicle-sign.keychain-db` +
  `security set-keychain-settings` (no auto-lock); (3) `security import devid.p12 -k
  <kc> -P <p12pw> -T /usr/bin/codesign`; (4) `security set-key-partition-list -S
  apple-tool:,apple:,codesign: -k <kcpw> <kc>` (uses the KC's own password — the login
  password is never needed); (5) **add the KC to the user search list**
  (`security list-keychains -d user -s <kc> <existing…>`) so trust anchors to the
  SYSTEM Apple Root; (6) build with `CSC_KEYCHAIN=<kc>` and NO `CSC_LINK`, and NO
  `CSC_NAME` (electron-builder rejects the `Developer ID Application:` prefix —
  auto-discovery finds the single identity). Sanity gate: `security find-identity -v
  -p codesigning` must print "1 valid identities found" before building; a lone
  `--keychain <kc>` (not in the search list) shows 0 valid. Notarization pre-flight:
  `xcrun notarytool history --key <p8> --key-id <id> --issuer <uuid>` → "No submission
  history" = creds OK. Team ID `9W7B6USGG9`.
- **Auto-update = electron-updater**, feed = `build.publish` github
  `chizhangucb/homebrew-chronicle` (baked into `app-update.yml`). It installs only when the running
  app and the update share a Developer ID signature — dormant until the first SIGNED
  release. `quitAndInstall()` does the clean quit + swap + relaunch, replacing the old
  `pkill`/`reinstall:mac` dance for end users. Mac targets are `["dmg","zip"]`;
  electron-updater updates from the ZIP, not the DMG.
- **The Relaunch toast** needs the preload
  (`electron/preload.cjs` → `window.chronicleUpdater`) + IPC in `electron/main.mjs`. In dev/standalone (browser) the
  bridge is absent, so the toast never renders. Updater calls are guarded by
  `app.isPackaged` — `npm run desktop` runs unpacked, so no update runs there. Note the
  toast is only visible after an update downloads — its *absence* is not proof the code is
  missing (verify by grepping the installed bundle for a marker string instead).
- **macOS App Management (TCC) blocks the harness from swapping the installed app.** Once
  `Chronicle.app` is in `/Applications` and signed, an agent/sandboxed shell can't `ditto`
  over it or `rm -rf` it → `Operation not permitted` (EPERM, not a running-process lock);
  only the user's own Finder/Terminal has App Management. Build the new `.app` in the repo,
  then have the USER do the final swap (Finder drag-replace, or a Terminal one-liner).
- **A local `electron-builder --dir` build SIGNS but does NOT notarize** (afterSign only
  fires with `APPLE_*` in env). Fine for a local reinstall — a locally-built app has no
  quarantine, so Gatekeeper runs it. For a shipped release use full `dist:mac` + notary env.
  And **bump the version for any new build**: two different builds both called `0.1.6` (a
  stale `release/` DMG vs current `main`) triggered a "my install is missing the latest
  features" hunt — the DMG was frozen at an older commit. Version = the truth; grep the
  bundle to confirm what's actually in it.
- **The auto-mode safety classifier gates outward/irreversible steps** — Vercel prod
  deploys, `git push` to the default branch, `gh release` publishing, `rm` of things
  outside the repo. Explicit user authorization in the immediately preceding turn usually
  clears it (the release pushes went through after "ship it"); otherwise route via a PR or
  hand the exact command to the user. Never work around a denial.
- **getchronicle.dev is served by the `chronicle-web` Vercel project — NOT `chronicle-site`.**
  This session accidentally created a duplicate `chronicle-site` project before noticing
  `chronicle-web` (the PR #11 landing project) already owned the apex; `chronicle-site` was
  deleted. The apex + `www` DNS (`A → 76.76.21.21`) already exist at Porkbun (coexisting with
  the MX/Resend email records), so wiring the site needs NO DNS change — just attach the domain
  to the project. `relay.getchronicle.dev` is a SEPARATE project (feedback-relay); leave it.
- **A `website/`-rooted `vercel` CLI deploy only uploads `website/`, NOT `../docs`** — so the
  docs content is generated LOCALLY (`npm run content` → `website/docs`) and uploaded, and
  Vercel's buildCommand is `vitepress build` + assemble (it does NOT re-run the `../docs`
  copy). `website/.vercelignore` must therefore NOT ignore `docs/` (the generated content must
  ship) but must ignore `dist`/`.vitepress/dist`/`.vitepress/cache`/`node_modules`.
- **VitePress base `/docs/` + `assemble.mjs`.** The docs are served under `/docs`, so VitePress
  builds with `base: '/docs/'` and its output is placed at `dist/docs`; nav/sidebar `link`s are
  srcDir-relative (base auto-prepends `/docs/`), and a link back to the landing at `/` must be
  an absolute/external URL (base would otherwise prepend `/docs/`). `assemble.mjs` copies the
  landing `index.html` + `assets/` to `dist/` root; the docs' hashed assets live at
  `dist/docs/assets` (own immutable cache header in `website/vercel.json`).
- **VitePress i18n structure.** Locales live under `srcDir`: English at `docs/*` (root locale),
  `docs/zh/**` + `docs/ja/**` for the others. `locales` in `config.mjs` sets each locale's
  `label`/`lang`/`link` plus its OWN translated `themeConfig` (nav + sidebar labels). A relative
  link in a translated page resolves WITHIN that locale, so every page must exist in every locale
  or the link 404s — and VitePress fails the build on dead links (the safety net). The changelog
  is GENERATED into `website/docs/changelog.md` (+ `zh`/`ja`) from repo-root `CHANGELOG.md` at
  build time; never hand-edit `website/docs/**` — edit `CHANGELOG.md` or the `docs/<lang>` sources.
  The `<Walkthrough/>` component reads `useData().lang` for captions, so it works in all three.
- **Multi-worktree collision (this session).** I branched off an OLD `main`; meanwhile the docs
  PR and the landing PR both merged, so my branch clobbered the landing `website/`. The fix was
  to rebranch off `main` and INTEGRATE (docs at `/docs` under the landing), not replace. Always
  rebase onto latest `main` before touching a shared dir/deployable — `git reset --hard` is
  blocked by the auto-mode classifier, so use `git checkout -b <branch> origin/main` instead.

## Verification habits used here

Features were verified against real data: this repo's own Claude Code session
(import → time travel → causality → replay of its own construction),
`~/health-analyst` (234 commits), the live `anthropics/skills` repo (GitHub import),
and fixture DBs/JSON for Cursor/Codex/Gemini/Copilot/OpenCode-live. Prefer that over
mocks: the fastest end-to-end check is importing Chronicle's own session and clicking
around. Known deferrals: remote SSH (no host to test), OAuth browser flow, destructive
skills takeover.
