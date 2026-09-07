# ADR 0009: The per-boot write token is the whole mutation guard

Every mutating route edits Chronicle's own records, and the server listens on loopback, so the threat is another page in the same browser posting to `127.0.0.1:41730`. Mutating routes carry a per-boot write token (`server/writeToken.ts`), minted at start and handed to the SPA: a same-origin guard, not authentication. Rejected: the tiered write gate Chronicle once carried (propose step, diff card, backup-and-verify ritual, audit table), built for a Chronicle that wrote outside its own folder and pointless after ADR 0008.

## Consequences

- A cross-origin page cannot drive the mutating routes. That is the whole threat model.
- A mutation is immediate. Deleting a session tombstones it so a re-sync never resurrects it; `undo-delete` restores it, and the source transcript is intact regardless because ADR 0008 says so.
- The token dies with the process, so a stale tab's writes fail after a restart and the SPA refetches. Correct, and the one routine failure mode.
- A route that writes outside the data folder is not covered by this reasoning. It contradicts ADR 0008 first.
- Guarded by `test/write-token.test.mjs`.
