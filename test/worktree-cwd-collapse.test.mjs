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
