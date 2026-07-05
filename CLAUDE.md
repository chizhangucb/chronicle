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
- `src/SessionView.jsx` — the core three-pane view; owns filtering, windowing, live SSE,
  mode switching (playback/refine/replay), causality panels
- `src/i18n.js` — `t()` dictionary EN/zh-CN; toggle reloads the page

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
- The repo path contains a space (`personal /ai-session-manager`) — always quote paths
  in shell commands.
- Update feed in `electron/main.mjs` points at placeholder `kite-ai/chronicle`; change
  when a real release repo exists (env override: `CHRONICLE_UPDATE_FEED`).

## Verification habits used here

Features were verified against real data: this repo's own Claude Code session
(import → time travel → causality → replay of its own construction),
`~/health-analyst` (234 commits), the live `anthropics/skills` repo (GitHub import),
and fixture DBs/JSON for Cursor/Codex/Gemini/Copilot/OpenCode-live. Prefer that over
mocks: the fastest end-to-end check is importing Chronicle's own session and clicking
around. Known deferrals: remote SSH (no host to test), OAuth browser flow, destructive
skills takeover, signed auto-update.
