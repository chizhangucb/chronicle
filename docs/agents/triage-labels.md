# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Wayfinder tickets

Wayfinder readiness is structural, not a label: a ticket is takeable when it is open, has no open blockers, and has no assignee. Assigning it is the claim.

Never run `/triage` over wayfinder tickets. The map authored them, so there is nothing to assess; triage is for issues that arrive raw.

A readiness label goes on `wayfinder:task` tickets only, because that is the one type whose mode is not fixed:

| Type | Mode | Readiness label |
| -------------------- | ------ | ------------------------------------ |
| `wayfinder:research` | AFK | none needed |
| `wayfinder:grilling` | HITL | none, and never `ready-for-agent` |
| `wayfinder:prototype`| HITL | none, and never `ready-for-agent` |
| `wayfinder:task`     | either | `ready-for-agent` or `ready-for-human` |

Never stamp `ready-for-agent` on a grilling or prototype ticket. Those resolve only through live exchange with a human, and an agent that picks one up will answer its own questions, which is the failure the ticket type exists to prevent.
