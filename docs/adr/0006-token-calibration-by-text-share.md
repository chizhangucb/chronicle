# ADR 0006: Per-bucket tokens are calibrated from text share

**Status:** Accepted

## Context

Explore and Content answer questions like "how many tokens did the Bash tool cost me?" and
"what share of my context is tool results?". The logs cannot answer them directly: tokens are
billed **per assistant API call**, not per tool call or per message kind. One call's usage
covers the whole prompt, whatever went into it.

Two ways to produce a per-bucket number.

**Estimate each bucket independently**, by counting characters and dividing by a
tokens-per-character constant. Each bucket is then plausible on its own, and the buckets sum
to a total that does not match the session's real spend, often by a wide margin. A user who
adds up the Content tab and compares it to the Spend tab finds two different answers and
trusts neither.

**Calibrate**: compute each bucket's *share* of message text length, then scale those shares
onto the billed total from `sessions.usage`.

## Decision

`server/calibrate.ts` is the one shared primitive for this. It scales text-length share onto
the real billed total, so per-bucket figures always sum to the session's actual token spend.

Results built this way carry `calibrated: true`, and the UI renders them with `≈` and a
tooltip that says the split is an estimate.

## Consequences

- Totals reconcile across every surface. The Content tab and the Spend tab agree.
- **The split between buckets is an estimate and is marked as one.** Text length is a proxy
  for tokens, and it is a worse proxy for buckets with unusual content (dense JSON, non-Latin
  text, long base64 blobs), which will read high or low against their true cost.
- The `≈` marker is load-bearing, not decoration. A calibrated number rendered without it
  claims a precision the method does not have, which is a defect.
- Every new per-bucket breakdown goes through `calibrate.ts` rather than deriving its own
  estimate, or the reconciliation guarantee is gone for that surface.
- Session totals themselves are exact, because they come from the logged `usage` payload.
  Only the split within a session is calibrated.
