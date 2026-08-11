# Changelog

Notable changes to Chronicle. Full history and downloads:
https://github.com/chizhangucb/chronicle/releases

## 1.0.0

- **Install via npm.** Chronicle is now `npx chronicle-cli` (requires Node 24+). The Electron desktop app and Homebrew/DMG install are retired.
- Tabbed **Insights** (Overview / Explore / Content), first-class **Subagents**, and per-project Explore/Content/Sessions tabs.
- Full TypeScript, invisible sync with tombstones + noise gate, stable URL routes.

## v0.2.1 — 2026-08-09

Safety and maintenance follow-up to v0.2.0:

- **Database snapshot before deletion** — Chronicle now snapshots
  `~/.chronicle/chronicle.db` before any project or session deletion, keeping
  the newest two snapshots, so an accidental delete is recoverable.
- **Dependency security fixes** — resolved 18 of 21 Dependabot alerts across
  the app and website (all transitive; no behavior changes). The remaining 3
  are dev-server-only issues in Vite 5, pending a VitePress 2.x upgrade.

## v0.2.0 — 2026-08-09

The substrate release: Chronicle becomes a metrics-grade session database while
staying a standalone product. Feature removals make this a minor bump.

- **Subagent (sidechain) import** — Claude Code subagent transcripts are now
  imported (with their agent type and skill attribution) instead of dropped.
  Their token spend counts in Cost & Usage; playback/refine stay main-chain by
  default. Per-message token columns unlock costliest-message and $-weighted
  attribution analyses.
- **Contract views** — external consumers (dashboards) read two stable SQL
  views, `contract_message_metrics` and `contract_sessions` (metrics + pointers,
  no content), versioned via `PRAGMA user_version`.
- **Truer durations, stored at import** — **Agent Active** now counts tool
  execution in full, caps other gaps at 10 minutes, and excludes only your real
  prompt pauses; a new **Engaged** metric (all gaps, 90-minute cap) approximates
  hands-on time. Both are stored per session and explained with ⓘ tooltips.
- **Auto-sync** — the tray app keeps imported projects fresh automatically: on
  launch, on wake from sleep, every 30 minutes, and when source logs change
  (debounced). Sessions written to in the last 10 minutes show an "ongoing"
  pill. Toggles in the new Settings modal, plus launch-at-login.
- **Full-text search** — global search (⌘K) is now FTS5-indexed, with a LIKE
  fallback on older databases.
- **`chronicle://session/<id>` deep links** — open a session directly from
  other apps.
- **Removed: MCP Hub, Skills Hub, and the pre-tool-use guard hook.** Chronicle
  refocuses on session history and metrics; security scanning, redaction, and
  share links remain.

## v0.1.10 — 2026-07-12

A sharper session metric, delivered via auto-update:

- **"Agent Active" (renamed from "Active Duration")** now measures agent working
  time correctly. It still excludes the pause before each of your prompts, but no
  longer counts background-task completions, in-app clicks, or interrupt markers as
  "you thinking" — those all carry a `user` role in the logs, so a background build
  finishing was being charged to your idle time. On a real session this moved the
  number from 33m to 43m of a 59m span. The ⓘ tooltip explains the distinction.

## v0.1.9 — 2026-07-12

Home-page and session-metric improvements, delivered via auto-update:

- **Multi-select project delete** — a new **Select** mode on the home page turns
  project cards into checkboxes, so you can remove several projects from Chronicle
  at once (Select-all / Clear + an inline confirm). Your source logs and folders are
  never touched.
- **Always-on toolbar** — **Search** (⌘K) and **+ Import Sessions** are now available
  from every view, not just the home page.
- **Truer Active Duration** — now counts all assistant-thinking and tool-execution time
  in full and excludes only the pause before each of your prompts (your reading/typing/
  away time). The old version dropped any gap over 5 minutes, undercounting long builds
  and deep thinks.
- **Cache-write cost split by TTL** — the Cost & Usage panel breaks cache-write tokens
  and dollars into **5-minute** and **1-hour** tiers, matching how each is billed.
- **Readable tooltips** — the ⓘ info bubbles open downward and are wider, so the full
  explanation is always visible.

## v0.1.8 — 2026-07-09

Download site + developer docs. **No app changes** — the desktop app is unchanged
from v0.1.7, so there's no update to install (like the v0.1.4 docs release).

- **[getchronicle.dev](https://getchronicle.dev)** — a clean download page that
  auto-detects your OS and offers one signed-&-notarized download, replacing the raw
  GitHub Releases list. It reads the latest release live, so new versions (and future
  Windows/Linux builds) appear automatically. Light + dark, mobile-responsive, with a
  real in-app Playback screenshot. Built as a new `website/` deployable on Vercel.
- **Developer documentation** — a layered `docs/` set (guide, architecture, reference)
  covering install, time-travel, MCP/Skills, parsers, packaging, security, and more.

## v0.1.7 — 2026-07-09

Session UX polish, delivered via auto-update:

- **⇧⌘U** — sync a single session from the keyboard.
- **Active Duration** — the session Overview now shows real working time (idle
  gaps over 5 minutes excluded) next to wall-clock duration, with an ⓘ explainer.
- **Refine → delete by type** — keep or drop whole message kinds (User /
  Assistant / Tool Call / …) in one click.
- **Consistent chat labels** — Playback and Refine now use the same wording.
- **Replay** — tidier sandbox toolbar.
- **Feedback** — optional sender email, set as `Reply-To` so replies reach you.
- **Fix** — switching language no longer jumps back to the home page.

## v0.1.6 — 2026-07-09

First **signed & notarized** release.

- **One-click auto-update** — an in-app "Relaunch to apply" toast installs updates
  and cleanly relaunches (electron-updater on a notarized Developer ID build).
- Feedback moved to **getchronicle.dev**.
- No more macOS quarantine. (0.1.5 was unsigned — upgrade to 0.1.6 once manually,
  then every update is automatic.)

## v0.1.5 — 2026-07-08

Cost & usage, global search, session titles, Japanese.

- **Cost & Usage** panel — local per-model token totals + dollar breakdown (no network).
- **Global search** palette (⌘K) across all session content, with scopes and filters.
- **Skill** and **MCP** distribution donuts on the session overview.
- Reads Claude Code `/rename` titles; inline rename; per-session Sync Update.
- Japanese (日本語) UI; project switcher dropdown; "Today" time filter.

## v0.1.4 — 2026-07-08

Documentation release — contributor docs (`CLAUDE.md`) captured the architecture,
release checklist, and gotchas. No functional changes since 0.1.3.

## v0.1.3 — 2026-07-07

Moved-repo fix + sync-all.

- Latest-`cwd`-wins so a moved project stops resurfacing under its old dead path.
- Sidebar **sync-all** button — re-import every project in one click.
- `npm run reinstall:mac` developer helper.

## v0.1.2 — 2026-07-07

Sidebar navigation + project analytics.

- Collapsible global **sidebar** (Projects, session modes, MCP Hub / Skills / Security / Feedback).
- **Project home**: 8 stat cards, activity trend (line/bar), tool distribution, call ranking, time-range filter.
- Breadcrumbs, session switcher, copyable session ID.

## v0.1.1 — 2026-07-07

First installable release + Refine polish.

- macOS **DMGs** (Apple Silicon + Intel) and a **Homebrew cask** (unsigned; `--no-quarantine`).
- Refine: Keep All / Delete All, sensible pre-deleted noise, a single clear savings bar.
- MIT license, README overhaul, PRD decision log.
