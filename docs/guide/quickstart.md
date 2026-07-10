# Quickstart

Install Chronicle and reach your first **time-travel** — clicking a message and watching your code snap back to how it looked at that moment — in about five minutes.

Chronicle's core trick is simple to experience but hard to forget: it lines up every message in an AI coding session against your Git history, so any point in the conversation becomes a window into the exact state of your code. Here's the whole loop in a few seconds:

<Walkthrough />

No account, no API key, no network — Chronicle reads the logs your AI tools already wrote to disk, entirely on your machine.

## 1 · Install

**macOS — download:** grab the app from **[getchronicle.dev](https://getchronicle.dev)**. One button, auto-detecting Apple Silicon vs Intel. Builds are **signed and notarized**, so they open with no Gatekeeper warning.

**macOS — Homebrew:**

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

**Run from source** (any platform — Windows/Linux installers aren't built yet):

```bash
npm install
npm run dev        # dev server → http://localhost:4173
```

After install, Chronicle keeps itself up to date — new signed releases download in the background and offer a one-click **Relaunch to update**. See [Installation](./installation.md) for run modes, requirements, and details.

## 2 · Pick a Git-backed project

Chronicle time-travels through **Git commits**, so choose a session whose project is a Git repository with some history. The more commits it has, the more precisely Chronicle can reconstruct code between messages. A project with no repo still plays back the conversation — you just won't get the code-snapshot pane.

## 3 · Import a session

1. **Launch Chronicle** (or `npm run dev` → http://localhost:4173). You'll land on the Projects home — empty on first run.
2. Click **+ Import Sessions**. Chronicle scans the standard log locations for all six supported tools and shows what it found. Pick a source — Claude Code is the richest if you have it.
3. The wizard lists sessions with **NEW / Partial / Imported** badges (new ones are pre-selected). Hit **Start Import** — it's read-only, so your original logs are never touched.

[Importing sessions](./importing-sessions.md) covers the full flow and all six tools.

## 4 · Time-travel

1. Back on the home screen, click a **project card**, then click any **session**.
2. The session opens on **Overview**; switch to **Playback** from the left rail (or press `⌘2`).
3. **Click any message.** The middle pane rebuilds your file tree and file contents **as they were at that moment**, resolved to the nearest preceding commit. Changed files are green-dotted and auto-selected. Press `D` for the diff.
4. **Drag along the TimberLine** (bottom) to scrub the whole session and watch the code evolve commit by commit.

That's the "aha." [Time travel](./time-travel.md) explains everything you're looking at.

> **Local-first:** Every step ran entirely on your machine. Chronicle made no LLM calls and no cloud requests — it parsed local logs into a local SQLite database and reconstructed code from your own Git history. Nothing about viewing a session leaves your laptop.

## Where to go next

- Missing a source, or want to understand the badges? → [Importing sessions](./importing-sessions.md)
- The full playback / diff / timeline reference → [Time travel](./time-travel.md)
- What the Overview tab tells you (cost, active duration, context) → [Session insights](./session-insights.md)

## Related

- [Installation](./installation.md) — run modes, requirements, and auto-update in depth.
- [Importing sessions](./importing-sessions.md) — the import wizard, the six tools, and read-only guarantees.
- [Time travel](./time-travel.md) — playback mode, snapshots, diff, and the TimberLine in depth.
