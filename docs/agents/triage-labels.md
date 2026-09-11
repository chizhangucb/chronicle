# Triage labels

When a skill names a triage role ("apply the AFK-ready triage label"), apply that role's label from this table: our label string for each of the five roles is the role's own name, spelled identically. `hold` is the sixth row and is nobody's role.

| Role              | Label             | Meaning                                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue                                                                       |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information                                                                      |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent                                                                       |
| `ready-for-human` | `ready-for-human` | Requires human implementation                                                                                 |
| `wontfix`         | `wontfix`         | Will not be actioned                                                                                          |
| none              | `hold`            | Ready, but not now; never dispatched, retried or requeued. It does not stop an open PR: close the PR for that |

## The one that holds a ticket back

`hold` is the brake among the labels, and it is the only one: the factory never dispatches, retries or requeues a ticket carrying it (`factory/dispatch/select.ts`). Removing it releases the ticket on the next sweep, which is within ten minutes. A ticket carrying `needs-triage` and `ready-for-agent` is dispatched, not held: `needs-triage` means a human still has to decide something about the ticket, and deciding is not the same as stopping it. Holding a finished ticket is `hold`.

Taking a human's label off an open issue triggers a sweep, as does adding `ready-for-agent` or unassigning someone, and a sweep re-scans every ticket rather than the one you touched. Two edits are quiet: the factory's own state labels (the `agent:` and `factory:` families), which it takes off itself at the end of a run, and anything you do to the labels or assignees of a closed issue.

## Stopping the factory on this repo

No label does it. The brake for the whole repo is the repository variable `FACTORY_PAUSED` (Settings -> Secrets and variables -> Actions -> Variables): set it to any non-empty value and nothing starts or advances here, no sweep, no implementer, no reviewer, no audit, no branch update. Open pull requests are still judged, since the merge gate is a required check. Clear the variable to start again; work that was skipped while paused is picked up by the next sweep, but an event that fired during the pause does not fire a second time. `.github/workflows/factory.yml` is where it is read and `test/factory-caller-wakeups.test.mjs` pins it.

## Wayfinder tickets

Readiness here is structural rather than a label: a ticket is takeable when it is open, has no open blockers and has no assignee. Assigning it is the claim.

`/triage` assesses issues that arrive raw from someone else. Wayfinder tickets come from the map, so they skip triage, and only `wayfinder:task` carries a readiness label: `ready-for-agent` where an agent can drive the work alone, `ready-for-human` where it needs a person's hands.

`wayfinder:grilling` and `wayfinder:prototype` resolve through live exchange with a human, so they stay unlabelled. Keep `ready-for-agent` off them: an agent that picks one up answers its own questions, which is the failure the ticket type exists to prevent.
