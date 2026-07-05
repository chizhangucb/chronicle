# Chronicle — Phase 1 Replay MVP Design

**Date:** 2026-07-03 · **Source spec:** [AI-session-manager-PRD.md](../../AI-session-manager-PRD.md) · **Scope:** PRD Phase 1 (+ light Phase 2 filtering/analytics)

## Decisions (made autonomously; PRD is the approved spec)

1. **Stack: local-first web app** — Node 24 + Vite/React frontend with an Express API mounted *into* the Vite dev server (single process, single port). The PRD recommends Tauri for GA; this codebase is structured (parsers / db / git engine / API / UI as separate modules) so the API layer can be lifted into a Tauri Rust or sidecar process later. Rationale: a working, demoable product this session beats an unbuildable Tauri scaffold.
2. **Datastore: `node:sqlite`** (built into Node 24) — zero native-compile risk, satisfies the PRD's SQLite requirement.
3. **Sources at MVP: Claude Code** (JSONL under `~/.claude/projects/`) **+ Codex** (JSONL under `~/.codex/sessions/`) adapters. Others are Phase 2+.
4. **Git snapshot engine shells out to `git`** (rev-list/ls-tree/show) — read-only, no libgit dependency.

## Requirements covered

- FR-IMP-2/3/4/6 — Import wizard: scan standard log dirs, list projects w/ session+message estimates, manual path browse, progress, empty states.
- FR-TT-1..5, TT-7, TT-8 — Three-pane Playback layout, typed message list w/ timestamps, file tree + file content + diff toggle (`D`), snapshot = nearest preceding commit, TimberLine timeline (blue user dots / green commit squares / gray AI-tool ticks, drag/hover/click, `←`/`→`/`Home`/`End`), empty-state when no git repo.
- FR-PM-1/2 — Logical projects keyed on physical path (`cwd` from logs), auto-aggregation across sources.
- FR-FLT-1/2/3/6 — Type chips (OR logic, match counts), tool request/result pairing, `Cmd+F` keyword search (300 ms debounce), non-destructive.
- FR-MODE-1 (lite) — Analytics overview: session count, message counts, tool-call distribution, activity.
- NFR-1/2 — Fully local, offline, read-only on source logs.

## Architecture

```
<repo root>/
  server/          # Express app (mounted in Vite via plugin)
    db.js          # node:sqlite schema + queries
    parsers/       # claudeCode.js, codex.js → normalized events
    git.js         # snapshot engine: commitAt(ts), tree, file, prevVersion
    api.js         # REST routes
  src/             # React UI: ImportWizard, ProjectList, SessionView
                   # (MessageList, CodePanel, Timeline, FilterBar), Analytics
```

**Normalized event model:** each JSONL line's content blocks flatten to rows: `user | assistant | thinking | tool_use | tool_result`, with `ts, uuid, text, tool_name, tool_input, tool_use_id` — tool results pair to calls by `tool_use_id`.

**Replay path:** select message → `GET /api/git/at?project&ts` → nearest commit ≤ ts → tree via `git ls-tree`, content via `git show commit:path`, diff = current vs previous commit's version of file (client-side line diff).

## Error handling

Unparseable JSONL lines skipped (counted); non-git projects get playback without snapshots + guidance; git commands sandboxed to project path, read-only.

## Testing

Parser unit-testable against real logs; primary validation = end-to-end on `~/health-analyst` (234 commits, real sessions): import < 5 s, click message → correct snapshot.
