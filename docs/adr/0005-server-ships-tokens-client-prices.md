# ADR 0005: The server ships token cells; the client prices them

**Status:** Accepted

## Context

Chronicle shows spend in several places: the Overview KPI strip, the Spend tab, Explore with
spend as the metric, per-session cost, costliest-message rankings. Each needs tokens turned
into dollars, using a per-model, per-token-class price table.

If the server computes dollars, the price table lives on the server, gets baked into stored
rows or cached results, and every surface inherits whatever prices were current when that row
was written. Two surfaces computed at different times then disagree, and a price correction
requires reprocessing rather than a redeploy.

## Decision

The server ships **token cells** and counts. It performs no dollar arithmetic and stores no
dollars. The client prices every displayed figure from one shared table (`src/models.ts`,
with `shared/pricing.ts` for the shared arithmetic).

The database stores tokens, never dollars.

## Consequences

- A price correction is a one-file edit that instantly re-prices all of history, with no
  migration and no cache invalidation.
- Two surfaces cannot disagree about the cost of the same tokens, because they run the same
  function over the same cells.
- The price table is a single source of truth. Adding a model means adding it there, never
  inlining a number at a call site.
- An API consumer reading Chronicle's data gets tokens and applies its own pricing, which is
  the correct boundary for someone on different rates.
- Any new analytics route follows the same rule: return cells, not currency. A route that
  returns dollars has moved the price table to the wrong side of the wire.
