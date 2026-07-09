# Quickstart

Go from a fresh install to your first time-travel — clicking a message and watching your code snap back to how it looked at that moment — in under five minutes.

Chronicle's core trick is simple to experience but hard to forget: it lines up every message in an AI coding session against your Git history, so any point in the conversation becomes a window into the exact state of your code. This walkthrough gets you to that "aha" as fast as possible. If you haven't installed yet, start with [Installation](./installation.md).

## Before you start

Chronicle time-travels through **Git commits**, so pick a session whose project is a Git repository with some history. The more commits the project has, the more precisely Chronicle can reconstruct code between messages. A project with no repo still plays back the conversation — you just won't get the code snapshot pane.

You don't need anything else: no account, no API key, no network. Chronicle reads the logs your AI tools already wrote to disk.

## Five minutes to first time-travel

1. **Launch Chronicle.** Open the app (or `npm run dev` and visit http://localhost:4173). You'll land on the Projects home. On first run it's empty with a "Welcome to Chronicle" prompt.

2. **Import a session.** Click **+ Import Sessions** (top right). Chronicle scans the standard log locations for all six supported tools and shows you which ones it found. Pick a source — Claude Code is the richest if you have it.

3. **Select what to import.** The wizard lists projects and, where it can, individual sessions with **NEW / Partial / Imported** badges. New sessions are pre-selected. Hit **Start Import** — it's read-only, so your original logs are never touched. ([Importing sessions](./importing-sessions.md) covers the full flow.)

4. **Open a project, then a session.** Back on the home screen, click a project card, then click any session in its list. The session opens on the **Overview** tab (a stats dashboard). Switch to **Playback** from the left rail (or press `⌘2`).

5. **Click a message — this is the moment.** Playback is a three-pane view: the conversation on the left, a **code snapshot** in the middle, and the **TimberLine** timeline along the bottom. Click any message and the middle pane rebuilds your file tree and file contents **as they were at that moment**, resolved to the nearest preceding commit. Files that changed in that commit are green-dotted and auto-selected. Press `D` to see the diff against the previous version.

That's it. Drag along the TimberLine to scrub through the whole session and watch the code evolve commit by commit. [Time travel](./time-travel.md) explains everything you're looking at.

> **Local-first:** Every step above ran entirely on your machine. Chronicle made no LLM calls and no cloud requests — it parsed local logs into a local SQLite database and reconstructed code from your own Git history. Nothing about viewing a session leaves your laptop.

## Where to go next

- Missing a source, or want to understand the badges? → [Importing sessions](./importing-sessions.md)
- Want the full playback / diff / timeline reference? → [Time travel](./time-travel.md)
- Curious what the Overview tab is telling you (cost, active duration, context)? → [Session insights](./session-insights.md)

## Related

- [Installation](./installation.md) — get Chronicle onto your machine first.
- [Importing sessions](./importing-sessions.md) — the import wizard, the six tools, and read-only guarantees.
- [Time travel](./time-travel.md) — playback mode, snapshots, diff, and the TimberLine in depth.
