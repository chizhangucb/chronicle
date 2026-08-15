# Worktree cwd collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chronicle map Claude Code sessions run inside a git worktree (`cwd = <repo>/.claude/worktrees/<name>`) to their parent repo project, so sync stops silently dropping worktree-origin sessions.

**Architecture:** Add a pure `collapseWorktree(path)` helper in the Claude parser and fold it into `reduceCwd`, the single chokepoint already called by both cwd-resolution sites (the scanner's `sniffProjectCwd` → `physicalPath`, and `parseClaudeSession` → `session.cwd`). Export both for unit testing. No schema, no UI, no product-contract change.

**Tech Stack:** TypeScript (strip-only, erasable-syntax), `node:test` + `node:assert/strict`, `node:sqlite`.

## Global Constraints

- Node ≥24; `.ts` run natively (strip-only). Erasable-syntax-only: no enum/namespace/param-properties. `npm run typecheck` (`tsc -b`) MUST exit 0.
- Explicit `.ts` import extensions, relative imports only, full `strict: true`. No `any`/`@ts-ignore`.
- Test files are `test/**/*.test.mjs`, run by `npm test`.
- Detection scope is `.claude/worktrees/` ONLY (confirmed decision). Silent merge into parent project — no marker, no new project.
- Invariant to preserve: autosync never creates new projects (`server/autosync.ts:141`).
- Branch `fix/worktree-cwd-collapse`; branch + PR per repo workflow.
- Any test touching server modules that start autosync must call `stopAutoSync()` in teardown — but this plan's test imports only pure parser functions, so no autosync is started (no teardown needed).

---

### Task 1: `collapseWorktree` + fold into `reduceCwd` (with regression pin)

**Files:**
- Modify: `server/parsers/claudeCode.ts` (the `reduceCwd` function at ~line 159; add `collapseWorktree` above it; add `export` to both)
- Test: `test/worktree-cwd-collapse.test.mjs` (create)

**Interfaces:**
- Produces:
  - `collapseWorktree(p: string): string` — strips a `/.claude/worktrees/<name>[/...]` suffix down to the parent repo root; returns non-worktree paths and falsy input unchanged.
  - `reduceCwd(pick: string, seen: Set<string>): string` — now applies `collapseWorktree` to `pick` and to every ancestor candidate before the existing shortest-seen-ancestor collapse. (Newly exported; behavior for non-worktree paths is unchanged.)

- [ ] **Step 1: Write the failing test**

Create `test/worktree-cwd-collapse.test.mjs`:

```js
// Regression pin (STANDING RULE) for worktree cwd collapse.
// Sessions run inside a superpowers git worktree record cwd as
//   <repo>/.claude/worktrees/<name>[/...]
// which is never a registered Chronicle project, so autosync/import silently
// dropped them (server/autosync.ts:141). reduceCwd now strips that segment down
// to the parent repo so worktree-origin sessions map to the parent project.
// Design: records/brainstorms/2026-08-14-worktree-cwd-collapse-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseWorktree, reduceCwd } from '../server/parsers/claudeCode.ts';

const REPO = '/Users/x/personal-projects/chronicle';

test('collapseWorktree strips a worktree segment to the parent repo', () => {
  assert.equal(collapseWorktree(`${REPO}/.claude/worktrees/feat`), REPO);
});

test('collapseWorktree strips a subdir inside a worktree to the parent repo', () => {
  assert.equal(collapseWorktree(`${REPO}/.claude/worktrees/feat/server`), REPO);
});

test('collapseWorktree leaves an ordinary repo path unchanged', () => {
  assert.equal(collapseWorktree(REPO), REPO);
  assert.equal(collapseWorktree(`${REPO}/server`), `${REPO}/server`);
});

test('collapseWorktree does not over-strip an unrelated "worktrees" path', () => {
  const p = '/Users/x/worktrees-notes/thing';
  assert.equal(collapseWorktree(p), p);
});

test('collapseWorktree passes falsy/empty through', () => {
  assert.equal(collapseWorktree(''), '');
});

test('reduceCwd maps a pure-worktree pick (parent never seen) to the repo', () => {
  const wt = `${REPO}/.claude/worktrees/feedback-round`;
  assert.equal(reduceCwd(wt, new Set([wt])), REPO);
});

test('reduceCwd maps a worktree subdir pick to the repo', () => {
  const wt = `${REPO}/.claude/worktrees/design-system/src`;
  assert.equal(reduceCwd(wt, new Set([wt])), REPO);
});

test('reduceCwd still collapses an ordinary subdir to a seen ancestor', () => {
  assert.equal(reduceCwd(`${REPO}/server`, new Set([`${REPO}/server`, REPO])), REPO);
});

test('reduceCwd leaves a plain repo cwd unchanged', () => {
  assert.equal(reduceCwd(REPO, new Set([REPO])), REPO);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/worktree-cwd-collapse.test.mjs`
Expected: FAIL — `collapseWorktree` / `reduceCwd` are not exported from `claudeCode.ts` (import error / undefined).

- [ ] **Step 3: Implement — add `collapseWorktree` and fold into `reduceCwd`**

In `server/parsers/claudeCode.ts`, replace the existing `reduceCwd` (around line 157-165):

```ts
// A session can record subdirectory cwds (e.g. <repo>/server). Walk the pick up
// to the shortest seen ancestor so grouping lands on the project root.

// Strip a superpowers git-worktree segment (<repo>/.claude/worktrees/<name>[/...])
// down to the parent repo root, so worktree-origin sessions map to the parent
// project instead of an ephemeral, unregistered worktree path (autosync skips
// any cwd that isn't a known project — server/autosync.ts). Detection is scoped
// to the .claude/worktrees/ convention only; a deleted worktree leaves no
// filesystem git-metadata, so a path heuristic is the only thing that works.
// Design: records/brainstorms/2026-08-14-worktree-cwd-collapse-design.md
export function collapseWorktree(p: string): string {
  return p ? p.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '') : p;
}

export function reduceCwd(pick: string, seen: Set<string>): string {
  let out = collapseWorktree(pick);
  for (const c of seen) {
    const cc = collapseWorktree(c);
    if (cc && cc !== out && out.startsWith(cc + '/')) out = cc;
  }
  return out;
}
```

(This adds `export` to `reduceCwd`, adds the `collapseWorktree` helper, and applies the strip to both `pick` and every `seen` candidate before the unchanged shortest-ancestor logic.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/worktree-cwd-collapse.test.mjs`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Type gate**

Run: `npm run typecheck`
Expected: exit 0 (no errors). If `reduceCwd`/`collapseWorktree` are flagged unused-export, that's fine — they're consumed by the test and internally.

- [ ] **Step 6: Commit**

```bash
git add server/parsers/claudeCode.ts test/worktree-cwd-collapse.test.mjs
git commit -m "fix: collapse .claude/worktrees/ cwds to parent repo so sync stops dropping worktree sessions

reduceCwd only collapsed to a seen ancestor; a pure-worktree session never
sees its parent cwd, so autosync's projectPaths.has(cwd) gate dropped it.
Strip the worktree segment down to the repo root at the reduceCwd chokepoint.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: End-to-end verification on real data + full gates

**Files:** none modified (verification + PR only).

**Interfaces:**
- Consumes: `collapseWorktree`/`reduceCwd` from Task 1; the live dev server on port 4173; the backup at `~/.chronicle/backups/orphan-worktree-sessions-20260814/`.

- [ ] **Step 1: Restore the two orphans to their original worktree cwd**

Prove the code (not the earlier manual file-patch) does the mapping. Restore the pre-patch originals from backup:

```bash
BK=~/.chronicle/backups/orphan-worktree-sessions-20260814
PROJ=~/.claude/projects/-Users-chizhang-personal-projects-chronicle
cp "$BK/c46ad96d-0ce2-4481-98c7-6b89d0b1823a.jsonl" "$PROJ/"
cp "$BK/57bf74ae-7aa9-4214-89e4-cf333a084e9f.jsonl" "$PROJ/"
# confirm cwd is back to the worktree path
grep -ho '"cwd":"[^"]*"' "$PROJ/c46ad96d-0ce2-4481-98c7-6b89d0b1823a.jsonl" | sort -u
```
Expected: cwd shows `.../.claude/worktrees/feedback-round` again.

- [ ] **Step 2: Force a re-parse and run incremental sync with the new code**

The dev server (port 4173) picks up the parser change via SSR reload. Bump mtime so the mtime pre-filter re-parses, then sync:

```bash
touch "$PROJ/c46ad96d-0ce2-4481-98c7-6b89d0b1823a.jsonl" "$PROJ/57bf74ae-7aa9-4214-89e4-cf333a084e9f.jsonl"
curl -s -X POST http://localhost:4173/api/autosync/run
```
Expected: `{"ok":true,"imported":>=2,...}`.

- [ ] **Step 3: Confirm both import under the chronicle project (5593) via the code**

```bash
sqlite3 -header -column ~/.chronicle/chronicle.db \
  "SELECT id, project_id, message_count FROM sessions WHERE id LIKE 'c46ad96d%' OR id LIKE '57bf74ae%';"
```
Expected: both rows, `project_id = 5593`. (If the dev server hadn't reloaded the parser, restart `npm run dev` and re-run Step 2.)

- [ ] **Step 4: Full local gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0; the new `worktree-cwd-collapse` test is included and green.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin fix/worktree-cwd-collapse
gh pr create --title "fix: collapse .claude/worktrees/ cwds to parent repo (sync dropped worktree sessions)" \
  --body "$(cat <<'EOF'
## Problem
Sessions run inside a git worktree record cwd `<repo>/.claude/worktrees/<name>`, which is never a registered Chronicle project, so autosync (`server/autosync.ts:141`, "never creates new projects") and the per-project Sync Update button silently drop them. Deleting the worktree orphans them permanently. Superpowers spawns worktrees constantly, so this recurs.

## Fix
Fold a `.claude/worktrees/` strip into `reduceCwd` (the single chokepoint feeding both `physicalPath` and `session.cwd`). Worktree-origin sessions now map to the parent repo project. Silent merge, no schema/UI/product-contract change.

## Regression pin
`test/worktree-cwd-collapse.test.mjs` (STANDING RULE).

## Verified
Restored two real orphans (`c46ad96d`, `57bf74ae`) to their worktree cwd and confirmed they import under the chronicle project via the code. typecheck + test + build green.

Design: `records/brainstorms/2026-08-14-worktree-cwd-collapse-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR created; CI (typecheck + test + build + Playwright E2E) runs.

---

## Self-Review

**Spec coverage:**
- Detection scope `.claude/worktrees/` only → Task 1 regex + over-strip test. ✓
- Silent merge into parent → collapse maps to existing project; no schema/UI. ✓
- Both failure paths (scanner dir-gate + per-session gate) → both funnel through `reduceCwd`; Task 2 verifies end-to-end import. ✓
- Regression pin → Task 1 Step 1. ✓
- End-to-end real-data proof → Task 2 Steps 1-3. ✓
- Invariant "never creates new projects" → preserved (maps to existing project); noted in constraints. ✓

**Placeholder scan:** none — all code and commands are literal.

**Type consistency:** `collapseWorktree(p: string): string` and `reduceCwd(pick: string, seen: Set<string>): string` are used identically in the test and the implementation. ✓
