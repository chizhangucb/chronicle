# Standards

What a change has to clear before it lands. Three rules, each of which exists because
something went wrong without it.

## A bug fix carries its regression pin, in the same PR

Fixing a bug without a test that fails on the old code is fixing it once. The pin is what stops
it coming back, and it belongs in the same PR as the fix, not in a follow-up issue.

The pin asserts the observable behaviour, not the shape of the fix: a route returns the right
number, a page shows the right element, two figures reconcile. A test written against the
internals of the patch pins the patch rather than the bug, and breaks on the next honest
refactor while letting the bug back in through a different route.

**Sweep before you pin.** A bug is rarely alone. When you find one, look for the same mistake
in its siblings, and fix the class rather than the instance. A duplicated heuristic, a missing
cache invalidation, a naive window cutoff: each of those has been wrong in more than one place
at once. The pin then covers the class.

If the sweep turns up more than the PR can carry, fix what you can, file the rest with what you
found, and say so in the PR description. Splitting the work is fine. Leaving it undiscovered is
not.

## Reshaping a surface needs Chi's sign-off

`spec/surface-contract.md` is the frozen product shape: routes, surfaces, sidebar and topbar
chrome, the enumerable sets, the per-surface content inventory, and the e2e pin table.

**The rule.** A PR that changes product shape needs a matching edit to the contract **and** a
sign-off note in the PR description naming Chi's confirmation. Without both it is drift by
definition: the release walk's conformance lens fails it and publish is blocked.

Reshaping means removing a surface, moving one, renaming one, changing a sidebar set, or
changing a surface's block and card inventory. The sign-off note is one line naming where the
confirmation came from: a message, a live review, a brainstorm.

### The additive exception

Purely additive changes are the exception to the sign-off half of the rule, not to the contract
edit.

Adding a new definition to the reference registry, a new column to an existing table, a new
optional field on a response: none of those change the shape a user navigates or invalidate a
statement already in the contract. Update the contract to describe what you added and land it.

The test is whether an existing statement in the contract becomes false. If one does, that is a
reshape and it needs the sign-off, however small the diff looks, and a one-line diff that
retires a card is exactly the case the rule was written for.

## The gates, and who wins

Green typecheck, tests and build before a PR goes up. Branch and PR for anything non-trivial;
direct-to-main is for agreed one-offs only.

`package.json` scripts and `.github/workflows/` are the source of truth for commands and gates.
When prose disagrees with either, the file is right and the prose is the bug: fix the prose in
the same PR rather than working around it.

## Reviewing

- **Propose removal.** A feature or module that no longer earns its place is a legitimate
  finding, and a welcome one. Say what it costs to keep. Keep-or-drop is Chi's call per finding.
- **Contradicting an ADR is allowed, silently overriding one is not.** If your change cuts
  against a decision in `docs/adr/`, name the ADR in the PR and make the case.
- **Vocabulary is checked.** `CONTEXT.md` is the glossary. Use its terms, including in issue
  titles and test names, and avoid the words it names as avoided.
