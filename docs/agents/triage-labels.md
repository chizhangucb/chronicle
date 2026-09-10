# Triage labels

Our label strings are the five canonical triage roles, spelled identically: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. When a skill names a role, use the same string.

## Two of them are brakes

`needs-triage` and `ready-for-human` are holds, not just states. The factory refuses any ticket carrying one (`factory/dispatch/select.ts`), so `needs-triage` + `ready-for-agent` is a legitimate pair meaning agent-ready but held, not a state-role conflict to clean up. Removing the hold releases the ticket to the factory on the next sweep, which is within ten minutes.

Any label edit on an issue triggers a sweep, removals included, and a sweep re-scans every ticket rather than the one you touched. There is no quiet label edit on a factory repo.

## Wayfinder tickets

Readiness here is structural rather than a label: a ticket is takeable when it is open, has no open blockers and has no assignee. Assigning it is the claim.

`/triage` assesses issues that arrive raw from someone else. Wayfinder tickets come from the map, so they skip triage, and only `wayfinder:task` carries a readiness label: `ready-for-agent` where an agent can drive the work alone, `ready-for-human` where it needs a person's hands.

`wayfinder:grilling` and `wayfinder:prototype` resolve through live exchange with a human, so they stay unlabelled. Keep `ready-for-agent` off them: an agent that picks one up answers its own questions, which is the failure the ticket type exists to prevent.
