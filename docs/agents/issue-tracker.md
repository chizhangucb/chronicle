# Issue tracker: GitHub

Issues and specs live as GitHub issues on `chizhangucb/chronicle`. Use `gh`.

- "Publish to the issue tracker" means create a GitHub issue; "fetch the relevant ticket" means `gh issue view <n> --comments`.
- Write multi-line bodies to a file and pass `--body-file`. An inline `--body` string loses backticks and `#` to the shell.

## Pull requests as a triage surface

**PRs as a request surface: no.** `/triage` reads this flag. Flipping it to `yes` runs external PRs through the same labels and states via the `gh pr` equivalents, where external means an `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`.

Issues and PRs share one number space, so a bare `#42` may be either: try `gh pr view 42`, fall back to `gh issue view 42`.

## Wayfinding operations

`/wayfinder` owns the vocabulary. This is only where GitHub keeps each piece.

| Piece    | Where it lives                                                                       |
| -------- | ------------------------------------------------------------------------------------ |
| Map      | an issue labelled `wayfinder:map`                                                      |
| Ticket   | a sub-issue of the map, labelled `wayfinder:<type>`                                    |
| Claim    | `gh issue edit <n> --add-assignee @me`, the session's first write                       |
| Blocking | native issue dependencies                                                              |
| Frontier | open sub-issues with `issue_dependencies_summary.blocked_by == 0` and no assignee       |

A blocking edge takes the blocker's **database id**, not its `#number` or `node_id`:

```bash
id=$(gh api repos/chizhangucb/chronicle/issues/<blocker> --jq .id)
gh api --method POST repos/chizhangucb/chronicle/issues/<child>/dependencies/blocked_by -F issue_id=$id
```

`issue_dependencies_summary` reads stale for a few seconds after that POST. Confirm the edge with `gh api repos/chizhangucb/chronicle/issues/<child>/dependencies/blocked_by`.

## A decision ticket ends at its resolution comment

A wayfinder ticket answers a question and closes. Work the answer uncovered is named in that comment, and reaches the tracker through the handoff: `/to-spec` collapses the cleared map into a plan, `/to-tickets` slices it into tickets carrying acceptance criteria and blocking edges, `/implement` builds each one. Straight to `/implement` only where the effort turned out small.

Triage sits outside this path (see `triage-labels.md`). [#183](https://github.com/chizhangucb/chronicle/issues/183) asked for one `needs-triage` issue per audit finding and produced 20 unshaped tickets, six of them keep/drop questions wearing `ready-for-agent`.
