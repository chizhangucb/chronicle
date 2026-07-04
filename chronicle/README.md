# Chronicle — AI Session Time Machine

Local-first session manager for AI coding assistants. Import your Claude Code / Codex
conversation logs, then click any message to **time-travel** to the exact code state at
that moment — reconstructed from your project's Git history.

Phase 1 (Replay MVP) of [the PRD](../AI-session-manager-PRD.md). Design doc:
[docs/superpowers/specs](../docs/superpowers/specs/2026-07-03-chronicle-phase1-design.md).

## Run

```bash
cd chronicle
npm install
npm run dev        # → http://localhost:4173
```

Click **Import Sessions**, pick a scanned project, and open a session.

## What's implemented

- **Import wizard** — scans `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/`
  (Codex), shows session/message estimates, imports read-only into a local SQLite DB
  (`~/.chronicle/chronicle.db`).
- **Logical projects** — sessions from all tools aggregate by physical project path;
  Git badge, source icons.
- **Playback Mode** — three-pane layout: typed message list (user / AI / thinking /
  tool call / tool result), code snapshot panel, TimberLine timeline.
- **Time travel** — selecting a message resolves the nearest preceding Git commit and
  renders the file tree + file contents *as they were at that moment*. Changed files
  are green-dotted and auto-selected.
- **Diff view** — toolbar toggle or `D`; shows the selected file vs. its previous
  committed version with compressed unchanged context.
- **TimberLine** — blue dots = user messages, green squares = commits, gray ticks =
  AI/tool events. Click/drag to seek, hover for timestamp, `←`/`→` fine-tune (1%),
  `Home`/`End` jump. Seeking selects the nearest message and updates the snapshot.
- **Filtering & search** — Conversation / Tool / Thinking chips (OR logic, tool
  request+result pairing), `⌘F` keyword search (300 ms debounce, highlight, match
  counts), combined filters, non-destructive.
- **Analytics (lite)** — per-project sessions, message counts, active days, tool-call
  distribution, activity sparkline.

## Architecture

```
server/            Express API, mounted inside the Vite dev server (one process)
  db.js            node:sqlite datastore (~/.chronicle/chronicle.db)
  parsers/         claudeCode.js, codex.js → normalized event model
  git.js           read-only Git snapshot engine (rev-list / ls-tree / show)
  api.js           REST: /api/scan /import /projects /sessions /git/*
src/               React UI (Vite)
```

All data stays on this machine. Source logs and project repos are never written to.

## Next phases (per PRD)

Cursor/Gemini adapters · manual path association · Refine Mode · security redaction ·
MCP Hub · Skills Hub · live streaming · remote SSH · Tauri desktop shell.
