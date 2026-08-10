# Chronicle Documentation

**Chronicle is a local-first time machine for AI coding sessions.** It imports the
conversation logs your AI coding assistants already write, and maps every message to the
exact state of your code at that moment — reconstructed from your project's Git history.
Click any message, and travel back to the code as it was.

Everything runs on your machine. There are **no LLM calls anywhere, no cloud backend, and
your source logs and project repos are never written to**. Chronicle observes and organizes
your AI tools; it never replaces them.

Chronicle imports from four tools today — **Claude Code, Codex, Cursor, and OpenCode** — and
unifies their sessions into a single, path-based project view.

> **New here?** Jump to the [Quickstart](guide/quickstart.md) and reach your first
> time-travel moment in under five minutes.

## The three pillars

Chronicle's design philosophy is **Replay · Measure · Secure**:

- **Replay** — time travel over any session, a deterministic replay sandbox, a refine mode for
  distilling a session into docs or a reusable prompt, and heuristic context causality linking
  what the AI read to what it changed.
- **Measure** — session insights with locally computed cost and stored duration metrics,
  subagent (sidechain) attribution, full-text search, background auto-sync that keeps
  everything fresh, and versioned SQL contract views for external consumers.
- **Secure** — one-click security check and redaction, and locally served, redacted share
  links. All parsing and storage stay on-device (see [Privacy & data](reference/privacy-and-data.md)).

## Guide

Get up and running.

| Page | What it covers |
| --- | --- |
| [Installation](guide/installation.md) | Homebrew, the signed DMG, running from source, and auto-update |
| [Quickstart](guide/quickstart.md) | Your first time-travel in under five minutes |

## Reference

| Page | What it covers |
| --- | --- |
| [Supported tools](reference/supported-tools.md) | The four-tool support matrix, log locations, and configuration (env vars, `config.json`, ports) |
| [Privacy & data](reference/privacy-and-data.md) | The local-first guarantees and the exact outbound calls |

## Architecture

For contributors who want to understand and extend the codebase.

| Page | What it covers |
| --- | --- |
| [How it works](architecture/how-it-works.md) | Single-process/single-port design, the data model, ingestion, the Git snapshot engine, security/live/replay, and the HTTP API |

Then see [Contributing](contributing.md) for dev setup, the branch-and-PR workflow, and how
changes are verified.

## Project background

The [`README`](../README.md) carries the full feature
inventory, and the [`CHANGELOG`](../CHANGELOG.md) tracks releases.

> **License:** Chronicle is [MIT licensed](../LICENSE).
