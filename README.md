# Chronicle — AI Session Time Machine

Local-first session manager for AI coding assistants. Import your conversation logs,
click any message to **time-travel** to the exact code state at that moment
(reconstructed from your project's Git history), and see where your tokens and time
actually go. Everything runs on your machine: no LLM calls, no cloud, no telemetry.
The one network call is opt-out — Chronicle can read *your own* Claude plan quota
from Anthropic (the same request Claude Code makes; Codex quota is read locally),
and one Settings toggle turns it off. Source logs and project repos are never
written to.

Full docs: **[getchronicle.dev/docs](https://getchronicle.dev/docs)**.

## Install

Requires **Node.js 24+** ([nodejs.org](https://nodejs.org)).

```bash
npx chronicle-cli
```

That starts the local app and opens the dashboard in your browser. Flags: `--port <n>`
to pick a port (default 41730, auto-advances if busy), `--no-open` to skip launching
the browser. Data lives at `~/.chronicle/chronicle.db` (override with `CHRONICLE_DATA_DIR`).

Then click **Import Sessions**, pick a source tool, and open a session.

## What it does

Full details for every feature live at **[getchronicle.dev/docs](https://getchronicle.dev/docs)**.
The highlights:

- **Import from 4 tools** — Claude Code, Codex, Cursor, and OpenCode, via a guided
  wizard. Read-only into a local SQLite DB (WAL-safe temp copies; originals never
  touched). Sessions aggregate into logical projects by repo path.
- **Home dashboard** — the landing page is a live Insights-overview: a Today/7d/30d
  KPI strip, a Today-only Activity block (live sessions + what happened "since you
  left"), a Burn tile, and a recent-sessions ledger with search, day-grouping, and
  bulk select below it. The project grid moved to its own **Projects** page.
- **Time-travel & Playback** — click any message to see your code exactly as it was,
  rebuilt from Git history, with file diffs, a scrubbable timeline of messages and
  commits, and a resizable conversation panel.
- **Insights** — a tabbed analytics home (Overview / Explore / Content) plus per-project
  tabs (Overview / Explore / Content / Sessions): cost, token magnitude, tool-call and
  content breakdowns, calibrated to true share. Explore adds an hourly time brush (with
  an "Other" rollup for long tails) and a per-session grouping view; Content surfaces 7
  usage characteristics (long sessions, workflow runs, subagent turns, high-context
  sessions, cache efficiency, and more) as scannable callouts.
- **Subagents** — sidechain (subagent) turns are first-class, including subagents
  Claude Code writes to separate transcript files/folders: attributed with token usage,
  surfaced in an Overview card with the real run count and a per-subagent drill-in, so
  subagent cost is no longer invisible.
- **Security redaction** — built-in and custom redaction rules with a
  detected-vs-redacted preview and a one-way redacted export.
- **Invisible sync** — background incremental import that keeps sessions fresh
  (tombstones for deletes, a noise gate, and pause controls) with no manual re-import.
  A topbar indicator shows "synced Xm ago" (or "syncing…" / "sync failed") and doubles
  as a click-to-sync-now button from anywhere in the app.
- **Refine** — distill a session into docs or a reusable prompt (Keep / Delete / Edit /
  Insert, token stats, Markdown export).
- **Search** — a Home command palette backed by an FTS5 full-text index (LIKE fallback)
  across all sessions; empty query shows recent access.
- **Cost & usage** — per-model token totals multiplied by a local, static price table
  (no billed data ever leaves your machine), split by cache-write TTL.
- **i18n** — English · 简体中文 · 日本語.

## Develop

```bash
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
npm run typecheck  # tsc -b (type gate; TS never emits — Node runs .ts natively)
npm test           # node --test over test/**/*.test.mjs
npm run build      # vite build → dist/
```

The server executes TypeScript directly (Node 24 strips types at load); there is no
build step for dev. See [AGENTS.md](AGENTS.md) and
[getchronicle.dev/docs](https://getchronicle.dev/docs) for architecture.

## Family

Chronicle is one of three local-first tools that work on their own and know about each other:

- **Chronicle** answers what happened in a session, in depth.
- **[nisse](https://github.com/chizhangucb/nisse)** is the repo your assistant lives in: taxonomy, governance, records.
- **[Varde](https://github.com/chizhangucb/varde)** is an operator console over your whole AI stack: spend, permissions, and what needs your eyes today. It detects Chronicle and links out to it for session depth rather than reimplementing it.

## License

[Apache-2.0](LICENSE). Third-party notices: [NOTICE](NOTICE).
