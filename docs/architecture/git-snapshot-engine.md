# Git Snapshot Engine

Time travel works because Chronicle treats **Git history as the source of truth for code state**. `server/git.js` reconstructs "what the code looked like at this message" by matching the message's timestamp to a commit and reading files out of it — read-only, shelling out to `git`, never a separate snapshot store and never current disk.

This page covers the engine's functions, how a selected message becomes a rendered snapshot or diff, and the two edge cases the code handles so you don't have to: merge commits and timestamps before a repo's first commit.

## Read-only by construction

Every function goes through one helper that runs `git` in the project directory with `execFileSync`:

```js
// server/git.js
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
```

There is no libgit2, no in-process git implementation. Two consequences follow, both intentional:

- **It uses whatever `git` the developer already has** — same version, same config, same submodule setup they trust — instead of reimplementing plumbing.
- **It is structurally read-only.** Every call is a query (`rev-list`, `ls-tree`, `show`, `diff-tree`, `rev-parse`, `log`). Nothing checks out, resets, or writes. Viewing history can't disturb the working tree, which is the point of "read-only on foreign systems."

## The functions

| Function | Git plumbing | Returns |
| --- | --- | --- |
| `isGitRepo(dir)` | `rev-parse --is-inside-work-tree` | boolean |
| `repoInfo(dir)` | `rev-list --count HEAD`, `rev-parse --abbrev-ref HEAD` | `{ isRepo, commitCount, branch }` |
| `commitsBetween(dir, from, to)` | `log --all --since --until` (±10 min pad) | commits for timeline ticks (oldest first) |
| `commitAt(dir, ts)` | `rev-list -1 --before=ts --all` | nearest commit at-or-before `ts` |
| `treeAt(dir, commit)` | `ls-tree -r --name-only` | file paths in that commit |
| `fileAt(dir, commit, file)` | `show commit:file` (+ previous version) | `{ content, previous, prevCommit, changedInCommit }` |
| `changedFiles(dir, commit)` | `diff-tree -m --first-parent` | files changed in the commit |

Two of these carry design decisions worth calling out.

**`repoInfo()` has no caching.** It runs `git` on every `/api/projects` call. That's deliberate: the project-card **git pill** (branch + commit count) is then always live and accurate — if you switch branches, the next render shows it. The flip side is a known footgun: if the pill shows a feature branch after a PR merged, the pill is *right* and the working tree is simply still on that branch. The fix is to switch the checkout back to `main`, not to touch the pill.

**`commitAt()` picks the nearest commit at or before the timestamp**, with a fallback:

```js
// server/git.js
export function commitAt(dir, ts) {
  if (!isGitRepo(dir)) return null;
  const hash = git(dir, ['rev-list', '-1', `--before=${ts}`, '--all']).trim();
  if (hash) return describeCommit(dir, hash);
  // ts precedes all history → oldest commit, flagged
  const oldest = git(dir, ['rev-list', '--max-parents=0', '--all']).trim().split('\n')[0];
  return oldest ? { ...describeCommit(dir, oldest), beforeHistory: true } : null;
}
```

`--before` gives the most recent commit that existed *at the moment the message was sent* — the code state the AI was actually looking at. When a message predates the repo's first commit (imported logs from before the project was under Git), there's nothing at-or-before it, so the engine falls back to the **oldest** commit and sets `beforeHistory: true` so the UI can say "this is earlier than any commit."

`commitsBetween()` **pads the range ±10 minutes** so timeline ticks near the edges of a session still show the commits that bracket it, rather than clipping a commit that landed a minute after the last message.

## From message to snapshot

The time-travel data flow, end to end:

```
select a message
   │  (message.ts)
   ▼
commitAt(dir, ts)        → nearest commit at-or-before the timestamp
   │
   ├─▶ treeAt(dir, hash)              → the file list at that commit  (file tree)
   │
   └─▶ fileAt(dir, hash, file)        → content at that commit
                                        + previous committed version   (diff view)
                                        + changedInCommit flag          (badge/highlight)
```

The API exposes this as `GET /api/git/at` (resolve a timestamp to a commit), `GET /api/git/tree` (the tree), and `GET /api/git/file` (a file plus its previous version). The UI renders the tree, and for a changed file shows a side-by-side diff of `previous` → `content`. `fileAt()` finds the previous version with `rev-list -1 <commit>~1 -- <file>` — the last commit that touched the file before this one — so the diff is against the real prior state, not the immediately preceding commit which may not have changed that file at all.

Because state is always reconstructed from history, the snapshot is faithful to **what was committed at that time** — not to what's on disk now, and not to a snapshot Chronicle took. The trade-off is honest and worth stating in docs: **fidelity tracks commit frequency.** Uncommitted work between two commits is invisible to the engine; more frequent commits mean finer-grained time travel. Submodules are supported to the extent the underlying `git` resolves them.

## Merge commits

Merge commits are the one place naive `diff-tree` lies. Against a merge, `diff-tree` with default options produces an *empty* diff, which would make a merge look like it changed nothing. Both `fileAt()` and `changedFiles()` pass `-m --first-parent` so the diff is computed against the first parent — the mainline before the merge — and the changed-file list comes out correct:

```js
git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r',
          '-m', '--first-parent', commit]);
```

This is already handled everywhere it matters; the note is here so a future change to the diff logic doesn't quietly reintroduce empty merge diffs.

## Related
- [Time travel](../guide/time-travel.md) — the Playback experience these functions power (snapshots, diffs, the timeline).
- [API reference](api-reference.md) — the `/api/git/*` routes and their parameters.
- [Architecture overview](overview.md) — where the git engine sits, and the "Git is the source of truth" principle.
