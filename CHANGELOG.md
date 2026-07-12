# Changelog

Notable changes to Chronicle. Full history and downloads:
https://github.com/chizhangucb/chronicle/releases

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
