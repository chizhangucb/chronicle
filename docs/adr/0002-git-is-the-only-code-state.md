# ADR 0002: Git history is the only source of code state

Time travel asks "what did the code look like when the model said this?". Git history is the only answer: `server/git.ts` resolves a message timestamp to the nearest commit at or before it and reads the file out of that commit, through read-only queries only (`rev-list`, `ls-tree`, `show`, `diff-tree`, `rev-parse`, `log`). Rejected: a Chronicle-owned snapshot store (a second version-control system), and current disk (today's file shown beside a three-week-old message).

## Consequences

- Chronicle stores conversation, never source.
- Fidelity tracks commit frequency: uncommitted work is invisible, and work between commits reads as the earlier commit. Revisited only on user demand.
- A message older than the first commit resolves to the oldest commit with `beforeHistory: true`.
- A project that is not a Git repo imports and plays back without a code pane.
