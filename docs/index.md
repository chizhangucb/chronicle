# Chronicle Documentation

**Chronicle is a local-first time machine for AI coding sessions.** It imports the
conversation logs your AI coding assistants already write, and maps every message to the
exact state of your code at that moment — reconstructed from your project's Git history.
Click any message, and travel back to the code as it was.

Everything runs on your machine. There are **no LLM calls anywhere, no cloud backend, and no
telemetry**. The only outbound call is opt-out: Chronicle can read *your own* Claude plan
quota from Anthropic (the same request Claude Code makes; Codex quota is read locally), and one
Settings toggle turns it off. Your source logs and project repos are never written to.
Chronicle observes and organizes your AI tools; it never replaces them.

Chronicle imports from four tools today — **Claude Code, Codex, Cursor, and OpenCode** — and
unifies their sessions into a single, path-based project view.

```bash
npx chronicle-cli
```

That's the whole install (Node.js 24+ required) — it starts a local server and opens your
browser to the dashboard.

> **New here?** Jump to the [Quickstart](guide/quickstart.md) and reach your first
> time-travel moment in a couple of minutes.

## The three pillars

Chronicle's design philosophy is **Time Travel · Measure · Secure**:

- **Time Travel** — click any message in a session and see your code exactly as it was, a
  scrubbable timeline over your commit history, a Refine mode for distilling a session into
  docs or a reusable prompt, and heuristic context causality linking what the AI read to what
  it changed.
- **Measure** — **Insights**, a tabbed dashboard (Overview / Explore / Content) available
  across all projects, scoped to one project, or scoped to one session — spend and token
  breakdowns, agent-active duration, tool-call distribution, and first-class **Subagents**
  attribution — plus full-text search and invisible background auto-sync that keeps
  everything fresh with no manual re-import.
- **Secure** — one-click Security Check with built-in and custom redaction rules, and a
  one-way redacted Markdown export. All parsing and storage stay on-device (see
  [Privacy & data](reference/privacy-and-data.md)).

## Guide

Get up and running.

| Page | What it covers |
| --- | --- |
| [Installation](guide/installation.md) | The `npx chronicle-cli` install, Node requirement, CLI flags, and data location |
| [Quickstart](guide/quickstart.md) | Your first time-travel in a couple of minutes |
| [Always-on local service](guide/local-service.md) | Run Chronicle as a login service (LaunchAgent/systemd) at a stable local URL |

## Reference

| Page | What it covers |
| --- | --- |
| [Supported tools](reference/supported-tools.md) | The four-tool support matrix, log locations, and configuration (env vars, `config.json`, ports) |
| [Privacy & data](reference/privacy-and-data.md) | The local-first guarantees and the exact outbound calls (there are none) |

## Architecture

For contributors who want to understand and extend the codebase.

| Page | What it covers |
| --- | --- |
| [How it works](architecture/how-it-works.md) | The single-process web app, the data model, ingestion, the Git snapshot engine, invisible sync, and the Insights engine |

Then see [Contributing](contributing.md) for dev setup, the branch-and-PR workflow, and how
changes are verified.

## Project background

The [`README`](../README.md) carries the full feature
inventory, and the [`CHANGELOG`](../CHANGELOG.md) tracks releases.

> **License:** Chronicle is [Apache-2.0 licensed](../LICENSE).
