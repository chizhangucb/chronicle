#!/usr/bin/env node
// Pre-PR staleness guard (CHI-362). Refuses to land a branch that is behind
// `origin/main`, so a stale branch is caught before the PR opens, not after it
// surfaces as a surprise DIRTY conflict (the CHI-324 PR #135 miss).
//
// Backs governance/build-discipline.md "Landing to main": rebase onto current
// main + dry-run the merge before landing. This is the unskippable version of
// that step. It is the Node twin of the hub's scripts/landing_preflight.py; it
// lives in-repo so a Chronicle dev (and CI) can run it with zero deps.
//
// Behavior:
//   - fetch origin/main (skippable with --no-fetch, for tests using a local ref)
//   - even-or-ahead of the target  -> exit 0 (merging main is a no-op, no conflict)
//   - behind the target            -> exit 1, with a per-file conflict map from a
//                                     `git merge --no-commit --no-ff` dry-run that
//                                     is always aborted (CI-safe: never mutates
//                                     the branch, never leaves a dirty tree)
//
// Usage:
//   node scripts/landing_preflight.mjs [--repo PATH] [--target REF] [--no-fetch]
//
// Exit: 0 up-to-date-and-clean; 1 behind or conflicting; 2 on a usage/env error
// (e.g. the working tree is already dirty, which this guard refuses to touch).
import { execFileSync } from 'node:child_process';

/** Run git; return trimmed stdout. Throws on non-zero unless `allowFail`. */
function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function revListCount(repo, range) {
  return Number(git(repo, ['rev-list', '--count', range]) || '0');
}

/**
 * Run the staleness preflight against `target`.
 * @returns {{
 *   target: string, behind: number, ahead: number, stale: boolean,
 *   conflicts: string[], clean: boolean, verdict: 'pass'|'fail'
 * }}
 * Pure w.r.t. the checked-out branch: any merge dry-run it starts is aborted
 * before returning, on every path.
 */
export function runPreflight({ repo = '.', target = 'origin/main', fetch = true } = {}) {
  // Refuse to operate with uncommitted TRACKED changes: the dry-run + abort
  // below can only guarantee restoration from a clean index/worktree. Untracked
  // files (porcelain `??`) are safe: `merge --abort` never touches them, and a
  // merge that would clobber one aborts on its own, so they don't block.
  const trackedDirty = (git(repo, ['status', '--porcelain']) || '')
    .split('\n')
    .filter((ln) => ln && !ln.startsWith('??'));
  if (trackedDirty.length) {
    throw new Error(
      'uncommitted tracked changes present; commit or stash before running the staleness guard:\n' +
        trackedDirty.join('\n'),
    );
  }

  if (fetch) {
    // Best-effort refresh of the target ref. A fetch failure (offline, no
    // remote) is fatal only if the target ref then does not resolve, below.
    git(repo, ['fetch', 'origin', 'main'], { allowFail: true });
  }

  // Resolve the target ref up front so a missing origin/main is a clear error,
  // not a confusing rev-list of 0.
  if (git(repo, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`], { allowFail: true }) == null) {
    throw new Error(`target ref ${JSON.stringify(target)} not found (fetch failed or ref missing)`);
  }

  const behind = revListCount(repo, `HEAD..${target}`);
  const ahead = revListCount(repo, `${target}..HEAD`);

  // Even-or-ahead: nothing on the target that HEAD lacks, so merging it changes
  // nothing and cannot conflict. Clean pass, no dry-run needed.
  if (behind === 0) {
    return { target, behind, ahead, stale: false, conflicts: [], clean: true, verdict: 'pass' };
  }

  // Behind: dry-run the merge purely to build the conflict map for the operator.
  // The verdict is already 'fail' (behind == stale); the map only distinguishes
  // "just rebase" from "resolve these files first".
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  let conflicts = [];
  try {
    // --no-ff so a fast-forwardable-but-behind branch still exercises a real
    // merge; --no-commit so nothing is committed.
    git(repo, ['merge', '--no-commit', '--no-ff', target], { allowFail: true });
    const unmerged = git(repo, ['diff', '--diff-filter=U', '--name-only'], { allowFail: true }) || '';
    conflicts = unmerged.split('\n').map((s) => s.trim()).filter(Boolean);
  } finally {
    // Cleanup only. Never throw from a finally (it would mask a try-block error;
    // eslint no-unsafe-finally): the HEAD check is done after this block, below.
    // `merge --abort` is a no-op-error when the merge was "Already up to date"
    // (no MERGE_HEAD); swallow that.
    git(repo, ['merge', '--abort'], { allowFail: true });
  }
  // Verify restoration after the finally. Should never trip (merge --no-commit
  // never moves HEAD), but if HEAD moved, fail loud rather than leave the tree
  // in an unexpected state.
  const headAfter = git(repo, ['rev-parse', 'HEAD'], { allowFail: true });
  if (headAfter !== headBefore) {
    throw new Error(`staleness guard left HEAD moved (${headBefore} -> ${headAfter}); investigate manually`);
  }

  return { target, behind, ahead, stale: true, conflicts, clean: conflicts.length === 0, verdict: 'fail' };
}

function render(r) {
  const lines = [`staleness guard: HEAD vs ${r.target}`];
  lines.push(`  behind: ${r.behind}   ahead: ${r.ahead}`);
  if (r.verdict === 'pass') {
    lines.push('  VERDICT: PASS (even-or-ahead of main).');
    return lines.join('\n');
  }
  if (r.clean) {
    lines.push(`  behind main by ${r.behind} commit(s), no conflicts: rebase onto main before opening the PR.`);
  } else {
    lines.push(`  behind main AND conflicting. Resolve these files before landing:`);
    for (const f of r.conflicts) lines.push(`    - ${f}`);
  }
  lines.push('  VERDICT: FAIL (branch is behind main). Rebase/sync onto current main, then re-run.');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { repo: '.', target: 'origin/main', fetch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-fetch') opts.fetch = false;
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message || err));
    return 2;
  }
  if (opts.help) {
    console.log('Usage: node scripts/landing_preflight.mjs [--repo PATH] [--target REF] [--no-fetch]');
    return 0;
  }
  let result;
  try {
    result = runPreflight(opts);
  } catch (err) {
    console.error(`staleness guard: ${String(err.message || err)}`);
    return 2;
  }
  console.log(render(result));
  return result.verdict === 'pass' ? 0 : 1;
}

// Run only when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
