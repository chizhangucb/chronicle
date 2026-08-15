# Worktree cwd collapse — design

**Date:** 2026-08-14
**Branch:** `fix/worktree-cwd-collapse`
**Status:** approved, ready for implementation plan

## Problem

Claude Code sessions run inside a git worktree record their `cwd` as
`<repo>/.claude/worktrees/<name>` (the superpowers `using-git-worktrees`
convention). Chronicle keys a session's project on its resolved `cwd`. A
worktree path is never a registered Chronicle project, so:

- `server/autosync.ts:141` — `if (!projectPaths.has(session.cwd)) continue;
  // auto-sync never creates new projects` — silently skips the session.
- The per-project "Sync Update" button is scoped the same way.

Once the worktree is deleted (`git worktree remove`), the cwd directory is gone
for good, and the session is orphaned: invisible to Chronicle unless manually
force-imported or its `cwd` is hand-rewritten. This drops every worktree-origin
session — a recurring loss because superpowers spawns worktrees constantly.

Observed real cases (this repo): `c46ad96d` (cwd `.../worktrees/feedback-round`)
and `57bf74ae` (cwd `.../worktrees/design-system`) never imported.
`406fd760` survived only because it was resumed once in the main repo, so
"latest cwd wins" happened to pick the main path.

### Why `reduceCwd` doesn't already handle it

`reduceCwd(pick, seen)` (`server/parsers/claudeCode.ts:159`) collapses a
subdirectory cwd to the **shortest ancestor that is also seen in the same
session**. A pure-worktree session only ever sees the worktree cwd — its parent
repo cwd never appears in `seen` — so there is no ancestor to collapse to.

## Decisions (confirmed with Chi)

1. **Detection scope: `.claude/worktrees/` only.** Collapse
   `<repo>/.claude/worktrees/<name>[/...]` → `<repo>`. This is the convention
   actually in use, and the only case detectable from a *deleted* worktree's
   path string (git commondir metadata is gone once the worktree is removed, so
   a filesystem-based general git-worktree detector cannot fix the orphan case
   that motivated this). Zero false-positive risk — `.claude/worktrees/` is a
   superpowers/Chronicle-specific path.
2. **Grouping: merge into parent, silent.** A worktree-origin session appears
   under the parent project indistinguishable from any other session. No marker,
   no schema change, no phantom `worktrees/<name>` project.

## Design

Single chokepoint. `reduceCwd` is already called at both cwd-resolution sites —
`sniffProjectCwd` (line 152, feeds `item.physicalPath` for the scanner) and
`parseClaudeSession` (line 495, sets `session.cwd`). Fold a worktree-strip in as
its first step so every caller benefits from one edit.

```js
// Strip a superpowers git-worktree segment (<repo>/.claude/worktrees/<name>[/...])
// down to the parent repo root, so worktree-origin sessions map to the parent
// project instead of an ephemeral, unregistered worktree path. See
// records/brainstorms/2026-08-14-worktree-cwd-collapse-design.md.
const collapseWorktree = (p: string): string =>
  p ? p.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '') : p;

function reduceCwd(pick: string, seen: Set<string>): string {
  let out = collapseWorktree(pick);
  for (const c of seen) {
    const cc = collapseWorktree(c);
    if (cc && cc !== out && out.startsWith(cc + '/')) out = cc;
  }
  return out;
}
```

Order matters: worktree-strip runs before the seen-ancestor collapse, so a
subdirectory *inside* a worktree (`.../worktrees/x/server`) still lands on the
repo root even when the only seen cwds are worktree paths.

### Why both failure paths are fixed

- **Scanner (dir-level gate):** the worktree munged dir's `physicalPath`
  resolves to `<repo>` → autosync's `projectPaths.has(item.physicalPath)` passes
  → its sessions are scanned.
- **Per-session gate:** `session.cwd` = `<repo>` → autosync's
  `projectPaths.has(session.cwd)` (line 141) passes → imported to the parent
  project.

### Invariants preserved

- "Autosync never creates new projects" — collapse maps to an *existing* parent
  project; it never fabricates a worktree project.
- No product-contract / IA change (silent merge, no new surface or enumerable) →
  no `.claude/product-contract.md` edit, no P0 IA-drift gate.
- Idempotent. Non-worktree paths untouched.

## Regression pin (STANDING RULE)

Ship a parser unit test in the same PR asserting `reduceCwd`:
- collapses `<repo>/.claude/worktrees/feat` → `<repo>`
- collapses `<repo>/.claude/worktrees/feat/sub` → `<repo>`
- leaves an ordinary path (`<repo>/server`) reducing to `<repo>` only via the
  existing seen-ancestor rule, and a bare `<repo>` unchanged
- does not over-strip a path that merely contains `worktrees` elsewhere

## End-to-end verification on real data

The two current orphans were hand-patched (cwd rewritten to main) during
triage. To prove the *code* fixes them rather than the manual patch: restore
`c46ad96d` + `57bf74ae` from
`~/.chronicle/backups/orphan-worktree-sessions-20260814/` (cwd back to the
worktree path), run `POST /api/autosync/run` with the new code, and confirm both
import under project 5593 (chronicle). Leave them on the restored originals
afterward — the file rewrites are then unnecessary.

## Files touched

- `server/parsers/claudeCode.ts` — add `collapseWorktree`, fold into `reduceCwd`
  (~4 lines + comment).
- parser test file — the regression pin above.

## Out of scope

- Generic (non-`.claude/worktrees/`) git worktrees — see decision 1.
- Any UI/schema surfacing of worktree origin — see decision 2.
- Backfilling historically-dropped worktree sessions beyond a one-time re-sync
  after deploy (the incremental sync picks them up once the code lands).
