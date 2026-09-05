# ADR 0009: The per-boot write token is the whole mutation guard

**Status:** Accepted

## Context

Every mutating route in Chronicle edits Chronicle's own records: rename a project, unlink one,
delete a session, change a setting, add a redaction rule. The server listens on loopback, so
the threat is not a remote attacker; it is another page in the same browser posting to
`127.0.0.1:41730` because it can.

Chronicle once carried a tiered write gate on top of that: a propose step, a diff card, a
backup-and-verify ritual, an audit table. It was built for a Chronicle that wrote outside its
own folder, and after ADR 0008 it guarded a rename against a threat model that no longer
existed. Every one of those steps was a surface to maintain, test and explain.

## Decision

Mutating routes carry a per-boot write token (`server/writeToken.ts`), minted at server start
and handed to the SPA. It is a same-origin guard and nothing more. There is no propose step, no
diff card, no backup-and-verify, no audit table and no undo.

The token is not authentication. Chronicle has no accounts, and anyone who can read the
loopback port's response can read the token.

## Consequences

- A cross-origin page cannot drive Chronicle's mutating routes, which is the threat the guard
  is for.
- A mutation is immediate and irreversible from inside the app. Deleting a session leaves a
  tombstone and is not undoable; the recovery path is re-importing from the source transcript,
  which is intact because ADR 0008 says so.
- The token dies with the process, so a stale tab's writes fail after a restart and the SPA
  refetches. That is correct, and it is the one routine failure mode.
- A future route that writes outside the data folder is not covered by this reasoning and
  cannot simply reuse the token. It contradicts ADR 0008 first.
- Guarded by `test/write-token.test.mjs`.
