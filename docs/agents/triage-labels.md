# Triage labels

Our label strings are the five canonical triage roles, spelled identically: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. When a skill names a role, use the same string.

## Wayfinder tickets

Readiness here is structural rather than a label: a ticket is takeable when it is open, has no open blockers and has no assignee. Assigning it is the claim.

`/triage` assesses issues that arrive raw from someone else. Wayfinder tickets come from the map, so they skip triage, and only `wayfinder:task` carries a readiness label: `ready-for-agent` where an agent can drive the work alone, `ready-for-human` where it needs a person's hands.

`wayfinder:grilling` and `wayfinder:prototype` resolve through live exchange with a human, so they stay unlabelled. Keep `ready-for-agent` off them: an agent that picks one up answers its own questions, which is the failure the ticket type exists to prevent.
