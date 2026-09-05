# Voice

How Chronicle writes: in docs, in code comments, in commit messages, in issues, in PR
descriptions, and in anything the UI says to a user. One voice everywhere.

## The rules

- **Concise.** Say the thing and stop. If a sentence survives being deleted, delete it.
- **Bullets over paragraphs** when the content is a list of independent points. Prose when the
  points depend on each other.
- **Casual, not chatty.** Write the way you would explain it to a colleague at the next desk.
- **No em dashes.** Use a comma, a colon, a full stop, or parentheses. This holds in files too,
  not only in chat.
- **No hype.** No "seamless", "powerful", "blazing fast", "revolutionary". A feature is
  described by what it does.
- **Lead with what needs action.** The reader's next move goes first, the background after.
- **Answer the question asked.** Do not answer the adjacent question you found more
  interesting.

## Words

`CONTEXT.md` is the glossary. Use its terms, and avoid the words it names as avoided. A synonym
that reads better in one sentence costs the reader the ability to search for the concept.

Name things the way the code names them. If the code and the docs disagree about what something
is called, one of them is a bug, and that is worth fixing rather than papering over.

## Comments

Write the **why**, because the what is already in the code below it. The comments worth having
explain a non-obvious constraint, a trap, a decision and its rejected alternative.

Match the density of the code around you. A file with a long header comment explaining its
boundary is following a convention; so is a file with almost none.

State the trap positively. "Copy the sidecars, or you read a stale database" beats "don't
forget the sidecars".

## Honesty

- A number that is an estimate is marked as an estimate. The `≈` on calibrated figures is
  load-bearing, not decoration.
- A known limit is documented as a limit. Uncommitted work is invisible to time travel; that
  belongs in the docs, not in a backlog of things to eventually mention.
- If tests fail, say so and show the output. If a step was skipped, say which. When something is
  done and verified, say so plainly without hedging.
- Do not claim a capability the product does not have. The README saying "no LLM calls
  anywhere" while `/ask` spawns Claude was a real bug, filed and fixed as one.

## Issues and PRs

Issues follow the template: What to build, Acceptance criteria, Blocked by. Acceptance criteria
are observable, so a reader can tell done from not done without asking.

A PR description says what changed and why, names the issue, and carries the sign-off note when
the change touches product shape. See [standards](standards.md).
