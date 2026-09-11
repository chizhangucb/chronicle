# Triage labels

When a skill names a triage role ("apply the AFK-ready triage label"), apply that role's label from this table. Our label strings are the five canonical triage roles, spelled identically.

| Role              | Label             | Meaning                                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue                                                                       |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information                                                                      |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent                                                                       |
| `ready-for-human` | `ready-for-human` | Requires human implementation                                                                                 |
| `wontfix`         | `wontfix`         | Will not be actioned                                                                                          |
| none              | `hold`            | Ready, but not now; never dispatched, retried or requeued. It does not stop an open PR: close the PR for that |

## The one that holds a ticket back

`hold` is the brake, and it is the only one: the factory never dispatches, retries or requeues a ticket carrying it (`factory/dispatch/select.ts`). Removing it releases the ticket on the next sweep, which is within ten minutes. A ticket carrying `needs-triage` and `ready-for-agent` is dispatched, not held.

Any label edit on an issue triggers a sweep, removals included, and a sweep re-scans every ticket rather than the one you touched. There is no quiet label edit on a factory repo.

## Wayfinder tickets

Readiness here is structural rather than a label: a ticket is takeable when it is open, has no open blockers and has no assignee. Assigning it is the claim.

`/triage` assesses issues that arrive raw from someone else. Wayfinder tickets come from the map, so they skip triage, and only `wayfinder:task` carries a readiness label: `ready-for-agent` where an agent can drive the work alone, `ready-for-human` where it needs a person's hands.

`wayfinder:grilling` and `wayfinder:prototype` resolve through live exchange with a human, so they stay unlabelled. Keep `ready-for-agent` off them: an agent that picks one up answers its own questions, which is the failure the ticket type exists to prevent.
