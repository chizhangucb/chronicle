# Chronicle Documentation

**Chronicle is a local-first time machine for AI coding sessions.** It imports the
conversation logs your AI coding assistants already write, and maps every message to the
exact state of your code at that moment — reconstructed from your project's Git history.
Click any message, and travel back to the code as it was.

Everything runs on your machine. There are **no LLM calls anywhere, no cloud backend, and
your source logs and project repos are never written to**. Chronicle observes and organizes
your AI tools; it never replaces them.

Chronicle imports from six tools today — **Claude Code, Codex, Cursor, OpenCode, Gemini CLI,
and GitHub Copilot Chat** — and unifies their sessions into a single, path-based project view.

> **New here?** Jump to the [Quickstart](guide/quickstart.md) and reach your first
> time-travel moment in under five minutes.

## The three pillars

Chronicle's design philosophy is **Replay · Measure · Secure**:

- **Replay** — [Time Travel](guide/time-travel.md) over any session, a deterministic
  [Replay sandbox](guide/replay-mode.md), [Refine](guide/refine-mode.md) for distilling a
  session into docs or a reusable prompt, and [Context Causality](guide/context-causality.md)
  linking what the AI read to what it changed.
- **Measure** — [session insights](guide/session-insights.md) with locally computed cost and
  stored duration metrics, subagent (sidechain) attribution, FTS5-backed
  [full-text search](guide/search-and-filtering.md), background [auto-sync](guide/auto-sync.md)
  that keeps everything fresh, and versioned
  [SQL contract views](architecture/metrics-and-contract.md) for external consumers.
- **Secure** — one-click [Security Check and redaction](guide/security-and-sharing.md) and
  locally served, redacted share links. All parsing and storage stay on-device (see
  [Privacy & data](reference/privacy-and-data.md)).

## Guide

Get up and running, then explore each feature.

| Page | What it covers |
| --- | --- |
| [Installation](guide/installation.md) | Homebrew, the signed DMG, running from source, and auto-update |
| [Quickstart](guide/quickstart.md) | Your first time-travel in under five minutes |
| [Importing sessions](guide/importing-sessions.md) | The import wizard, all six sources, and the read-only guarantees |
| [Time travel](guide/time-travel.md) | Playback mode, code snapshots, diff view, and the TimberLine timeline |
| [Search & filtering](guide/search-and-filtering.md) | Type-filter chips, `⌘F` search, and the FTS5-backed `⌘K` command palette |
| [Session insights](guide/session-insights.md) | Overview stats, Active Duration, Cost & Usage, and the context-window bar |
| [Refine mode](guide/refine-mode.md) | Distill a session with Keep / Delete / Edit / Insert, then export |
| [Replay mode](guide/replay-mode.md) | Deterministic re-execution in an isolated sandbox |
| [Project management](guide/project-management.md) | Logical projects, association, the Git pill, and sync |
| [Context causality](guide/context-causality.md) | Heuristic read → change linking with confidence tiers |
| [Live streaming](guide/live-streaming.md) | Watching in-progress sessions in real time |
| [Auto-sync](guide/auto-sync.md) | Background incremental import, the ongoing indicator, and `chronicle://` deep links |
| [Security & sharing](guide/security-and-sharing.md) | Security Check, custom rules, and share links |

## Reference

| Page | What it covers |
| --- | --- |
| [Keyboard shortcuts](reference/keyboard-shortcuts.md) | Every shortcut, grouped by mode |
| [Compatibility](reference/compatibility.md) | The six-tool support matrix and per-tool log locations |
| [Configuration](reference/configuration.md) | The `~/.chronicle/` layout, environment variables, and `config.json` |
| [Privacy & data](reference/privacy-and-data.md) | The local-first guarantees and the exact outbound calls |

## Architecture

For contributors who want to understand and extend the codebase.

| Page | What it covers |
| --- | --- |
| [Overview](architecture/overview.md) | Single-process/single-port design, run modes, component map, and principles |
| [Data model](architecture/data-model.md) | The SQLite schema, the normalized event model, and `replaceSession` |
| [Parsers & ingestion](architecture/parsers-and-ingestion.md) | The event model in depth, plus how to add a new source |
| [Git snapshot engine](architecture/git-snapshot-engine.md) | Reconstructing code state from Git history |
| [Metrics & contract views](architecture/metrics-and-contract.md) | Sidechain and per-message token columns, stored durations, the `contract_*` views, and FTS5 |
| [Security, live & replay](architecture/security-live-replay.md) | The redaction engine, SSE watchers, the replay engine, and causality |
| [API reference](architecture/api-reference.md) | Every REST route, the SSE stream, and `/share` |
| [Desktop & packaging](architecture/desktop-packaging.md) | The Electron shell, signing, auto-update, and the release flow |

Then see [Contributing](contributing.md) for dev setup, the branch-and-PR workflow, and how
changes are verified.

## Project background

Chronicle was built from a detailed [product requirements document](AI-session-manager-PRD.md);
its [decision log](AI-session-manager-PRD.md#9-decision-log-post-implementation) records what
shipped versus what was deferred. The [`README`](../README.md) carries the full feature
inventory, and the [`CHANGELOG`](../CHANGELOG.md) tracks releases.

> **License:** Chronicle is [MIT licensed](../LICENSE).
