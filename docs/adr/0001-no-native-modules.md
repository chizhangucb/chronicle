# ADR 0001: No native modules

`npx chronicle-cli` must run on a stranger's machine with no setup step, and a native module (`better-sqlite3`, `nodegit`) needs a C toolchain or a prebuilt binary for that exact platform and Node ABI. So nothing native anywhere in the dependency tree: SQLite is `node:sqlite`, Git is `execFile` against the `git` already on the machine.

## Consequences

- Node 24 is the floor, because that is where `node:sqlite` works. Not negotiable downward.
- No user-defined SQL functions; heavy work is SQL or JavaScript over rows.
- Each Git call is a process spawn, so hot paths batch and run concurrently.
- Git behaviour is the user's `git`, config included. A bug report should say which.
