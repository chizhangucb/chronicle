# ADR 0002: Git history is the only source of code state

**Status:** Accepted

## Context

Time travel means answering "what did the code look like when the model said this?". Three
ways to answer it:

1. Snapshot the working tree yourself at import time, or on a timer, into a Chronicle-owned
   store.
2. Read the file off current disk and show that.
3. Reconstruct from Git history: match the message timestamp to a commit and read the file
   out of that commit.

Option 1 makes Chronicle a second version-control system, with its own storage growth,
its own pruning policy, and its own bugs. Option 2 is a lie that looks correct: the file
shown next to a three-week-old message is today's file.

## Decision

Git history is the only source of code state. `server/git.ts` resolves a message timestamp to
the nearest commit at or before it, then reads the tree and the file out of that commit. No
snapshot store, and never current disk.

Every call is a read-only query (`rev-list`, `ls-tree`, `show`, `diff-tree`, `rev-parse`,
`log`). Nothing checks out, resets, stashes or writes.

## Consequences

- Chronicle stores no code. The database holds conversation, not source.
- **Fidelity tracks commit frequency.** Work that was never committed is invisible, and work
  between two commits reads as the earlier commit. This is a known, documented limit; it is
  revisited only on user demand, not pre-emptively.
- A message older than the repo's first commit resolves to the oldest commit with
  `beforeHistory: true`, rather than failing.
- A project that is not a Git repo still imports and plays back; it just has no code pane.
- Merge commits need `-m --first-parent`, or `diff-tree` reports an empty diff. See
  [gotchas](../contributing/gotchas.md).
