# ADR 0006: Per-bucket tokens are calibrated from text share

Tokens are billed per assistant API call, so "how many tokens did the Bash tool cost?" has no direct answer in the logs. `server/calibrate.ts` computes each bucket's share of message text length and scales it onto the session's billed total, so buckets always sum to real spend; results carry `calibrated: true` and render with `≈`. Rejected: estimating each bucket independently from character counts, which produces buckets that sum to a total disagreeing with the Spend tab.

## Consequences

- Session totals are exact (from the logged `usage`); only the split within a session is an estimate, and it reads high or low for unusual content (dense JSON, non-Latin text, base64).
- The `≈` marker is load-bearing. A calibrated number without it claims a precision the method lacks, which is a defect.
- Every per-bucket breakdown goes through `calibrate.ts`, or the reconciliation guarantee is gone for that surface.
