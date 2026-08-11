# Quickstart

Run Chronicle and reach your first **time-travel** moment — clicking a message and watching
your code snap back to how it looked at that instant — in a couple of minutes.

Chronicle's core trick is simple to experience but hard to forget: it lines up every message
in an AI coding session against your Git history, so any point in the conversation becomes a
window into the exact state of your code. Here's the whole loop in a few seconds:

<Walkthrough />

No account, no API key, no network — Chronicle reads the logs your AI tools already wrote to
disk, entirely on your machine.

## 1 · Launch it

```bash
npx chronicle-cli
```

That's the whole install. `npx` fetches Chronicle, starts a local server (default
`http://localhost:41730`), and opens your browser to the dashboard automatically. Requires
**Node.js 24+** — see [Installation](./installation.md) if you need to check or upgrade your
Node version, or want the `--port`/`--no-open` flags. Press `Ctrl-C` in the terminal to stop
it whenever you're done.

## 2 · Land on Home

The dashboard opens on **Home**: a day-grouped stream of your most recent sessions across
every tool, with search up top and a project rail on the right. First run, this is empty — the
next step fills it in.

## 3 · Import your sessions

1. Click **+ Import Sessions** (top bar, available from any view). Chronicle scans the
   standard log locations for all four supported tools — **Claude Code, Codex, Cursor, and
   OpenCode** — and shows what it found on your machine, no configuration required.
2. Pick a source — Claude Code is usually the richest if you have it installed.
3. The wizard lists sessions with **NEW / Partial / Imported** badges (new ones are
   pre-selected). Hit **Start Import** — it's read-only, so your original logs are never
   touched.

After the first import, Chronicle keeps itself in sync automatically — new sessions and
updates to in-progress ones are picked up in the background as you use your AI tools, with no
manual re-import needed. See [Supported tools](../reference/supported-tools.md) for the full
tool matrix and log locations.

## 4 · Pick a Git-backed project

Chronicle time-travels through **Git commits**, so open a session whose project is a Git
repository with some history. The more commits it has, the more precisely Chronicle can
reconstruct code between messages. A project with no repo still plays back the conversation —
you just won't get the code-snapshot pane.

## 5 · Time-travel

1. From Home, click a **project card** on the right rail, then click any **session** — or open
   one straight from the recent-sessions stream.
2. The session opens on **Overview** — stats, cost & usage, agent-active time, and a
   Subagents card if the session used any. Switch to **Playback** from the left rail (or press
   `⌘2`).
3. **Click any message.** The middle pane rebuilds your file tree and file contents **as they
   were at that moment**, resolved to the nearest preceding commit. Changed files are
   green-dotted and auto-selected. Press `D` for the diff.
4. **Drag along the timeline** (bottom) to scrub the whole session and watch the code evolve
   commit by commit.

That's the "aha" — the whole point of Chronicle.

## 6 · Explore Insights

Click **Insights** in the sidebar for the cross-project view — three tabs: **Overview** (spend,
tokens, agent-active time, tool mix, and a top-sessions-by-cost table across everything you've
imported), **Explore** (a pivot table — slice spend/tokens/requests by model, project, source,
tool, skill, or subagent), and **Content** (what's actually filling your context — tool
results, skills, and subagents, as a share of total tokens). The same three tabs exist scoped
to a single project (its **Overview / Explore / Content / Sessions** tabs) and scoped to a
single session (from that session's Overview, drill into **Content**).

> **Local-first:** Every step ran entirely on your machine. Chronicle made no LLM calls and no
> network requests — it parsed local logs into a local SQLite database and reconstructed code
> from your own Git history. Nothing about viewing a session leaves your laptop.

## Related

- [Installation](./installation.md) — the Node requirement, CLI flags, and where data lives.
- [Supported tools](../reference/supported-tools.md) — the tool matrix, log locations, and
  configuration.
- [How it works](../architecture/how-it-works.md) — the ingestion pipeline, the Git snapshot
  engine, and the Insights engine in depth.
