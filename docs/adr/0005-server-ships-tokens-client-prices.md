# ADR 0005: The server ships token cells; the client prices them

The server returns token cells and counts, does no dollar arithmetic and stores no dollars; the client prices every figure from one table (`src/models.ts`, arithmetic in `shared/pricing.ts`). Pricing on the server was rejected because dollars baked into rows or caches inherit whatever prices were current when written, so two surfaces disagree and a price correction needs reprocessing.

## Consequences

- A price correction is a one-file edit that re-prices all history, with no migration or cache invalidation.
- Two surfaces cannot disagree on the cost of the same tokens.
- Adding a model means adding it to the table, never a number at a call site.
- A route that returns dollars has moved the price table to the wrong side of the wire.
