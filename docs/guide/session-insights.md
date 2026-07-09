# Session insights

The Overview tab is a session's home page: duration, cost, token usage, tool/skill/MCP distribution, and the controls to rename or delete it — all computed locally from the log.

Every session opens on **Overview** (`⌘1`), a dashboard that answers "what happened here, and what did it cost?" without you leaving the app or trusting a billing dashboard. Everything on this page is derived on your machine from the imported log: token counts come from the log, dollar figures are computed from a static price table, and the heuristics (like Active Duration and the error count) are the same local rules used elsewhere in Chronicle. There are no LLM calls and no network requests behind any of these numbers.

## Stat cards

A row of cards up top:

- **Total Duration** — wall-clock span from the first message to the last.
- **Active Duration** — time actually spent working. This one's worth understanding.
- **Messages**, **Tool Calls**, **Errors** — counts. Errors are tool results that look like failures (matching an error/traceback/`exit code`/"permission denied" heuristic).
- **Context** — the real context-window size at the last message (only shown when captured; see below).

### Active vs. Total Duration

Active Duration sums the gaps between consecutive message timestamps but **excludes any gap longer than five minutes** — the idea being that a pause over five minutes is you walking away, not working. So on a session you picked at over two days, Total Duration might read "50h" while Active Duration reads "3h 20m". That's not a bug; it's the point. An **ⓘ** tooltip on the card explains the distinction inline, since the gap between the two numbers surprises people.

## Cost & Usage

Logs carry **tokens, not dollars** — no AI tool records what a session cost you. Chronicle reproduces the cost the way Claude Code's `/usage` does: it aggregates per-model token totals from the log and multiplies by a static list-price table (`src/models.js`, never fetched at runtime).

The panel breaks down, per model:

- token totals for **Input**, **Output**, **Cache Read**, and **Cache Write**;
- a **per-category dollar breakdown** and a per-model subtotal;
- a **session total** in the panel header.

A subtlety that matters for accuracy: **5-minute and 1-hour cache writes are priced separately**. Claude Code bills each cache-write tier at a different rate, and a session can be entirely one or the other, so Chronicle keeps them split and sums them correctly. Unpriced models (some non-Claude sources) show token counts but a `—` for cost rather than guessing.

> **Note:** These are estimates from token counts × current list prices, meant to match `/usage`. They're computed locally and are only as current as the price table in `src/models.js` — when Anthropic changes pricing, that table is what gets updated.

## Context-window usage bar

Below Cost & Usage, a bar shows real token usage against the model's context window (from a static per-model table). It fills and shifts color as it approaches the limit — **cyan → yellow → red** — so you can see at a glance how close a session ran to the ceiling.

This bar (and the Context stat card) only appears when Chronicle captured `context_tokens`, which happens **at import time**. If you upgraded Chronicle after importing a session, re-import or run **Sync Update** to backfill it; otherwise the session falls back to the rough `~chars/4` estimate elsewhere in the UI.

## Distribution donuts

Three hand-rolled donut charts show where the session spent its tool budget:

- **Tool Distribution** — calls by tool (Bash, Write, Edit, Read, …), top entries plus an aggregated "other".
- **Skill Distribution** — `Skill` invocations grouped by skill name.
- **MCP Distribution** — `mcp__<server>__<tool>` calls grouped by server.

Alongside them, a **Call Timeline** and **Call Details** list the actual events, with error markers.

## Rename and the display name

Rename a session inline from the Overview title (the ✎ button) — an edit-in-place field, not a browser prompt. The name you set is a Chronicle-local override that **survives re-import**.

The title you see follows a single precedence, defined once by `sessionDisplayName()` in `src/ProjectDetail.jsx` and reused everywhere (rows, pickers, the Overview title):

```
name (your Chronicle override)  →  summary (parsed title, e.g. Claude Code's /rename, last one wins)  →  first_prompt
```

Leaving the rename field blank resets to the default (the parsed title or first prompt).

## Danger zone

At the bottom, a **Source file** panel lets you delete a session, with a two-step inline confirm on each action:

- **Delete source file** — remove the original log from disk; the imported copy stays in Chronicle.
- **Delete everywhere** — remove the original log *and* the Chronicle copy.
- **Delete from Chronicle** — remove only the imported copy; the original log stays and can be re-imported.

Per-file source deletion is offered only for sources where one file equals one session (Claude Code, Codex, Copilot). Cursor and OpenCode share a single database across sessions, so their source files are never deleted per-session. Deletion is disabled while a session is live (its log is still being written).

## Project analytics (lite)

Zoom out one level — the project page — and you get per-project analytics over a time range you pick (**Today / 7 / 30 / 365 days**): sessions, total and average duration, active days, message and tool-call counts, an error rate, a source-distribution donut, a call-ranking bar chart, and an **activity sparkline** (line or bar) of sessions per day. It's a lightweight roll-up of the same locally-computed data, scoped to the whole project instead of one session. [Project management](./project-management.md) covers the rest of the project page — association, sync, and the Git pill.

## Related

- [Project management](./project-management.md) — the project page, logical projects, sync, and association.
- [Configuration](../reference/configuration.md) — where the database and captured data live under `~/.chronicle/`.
