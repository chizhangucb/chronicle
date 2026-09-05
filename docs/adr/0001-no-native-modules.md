# ADR 0001: No native modules

**Status:** Accepted

## Context

Chronicle ships as `npx chronicle-cli` and must run on a stranger's machine with no setup
step. The two things it needs are a SQLite database and read access to Git history. The
obvious libraries for both are native: `better-sqlite3` compiles at install time, and
`nodegit`/libgit2 links a C library.

A native module means the user needs a working C toolchain, or a prebuilt binary exists for
their exact platform and Node ABI. Either way, `npx` can fail on a machine that has nothing
wrong with it.

## Decision

No native modules anywhere in the dependency tree.

- SQLite is `node:sqlite` (`DatabaseSync`), which is built into Node.
- Git is `execFile`/`execFileSync` against the `git` binary already on the machine.

## Consequences

- `npx chronicle-cli` needs no compiler and no prebuilt-binary matrix.
- **Node 24 or newer is required**, because that is where `node:sqlite` is usable. That floor
  is not negotiable downward, and it is the same floor that native `.ts` execution needs
  ([architecture](../contributing/architecture.md)).
- `node:sqlite` is a smaller API than `better-sqlite3`. There is no user-defined-function
  escape hatch to reach for, so heavy work is written as SQL or as JavaScript over rows.
- Git operations pay a process spawn each. That is why the hot paths batch and run
  concurrently rather than looping serially.
- Git behaviour is whatever the user's `git` does, including their config. That is a feature
  for trust and a variable for reproduction: a bug report should say which `git`.
