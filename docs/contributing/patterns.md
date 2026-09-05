# Patterns

The conventions the codebase actually follows, and the loop that verifies a change.

## TypeScript

Chronicle's server runs `.ts` directly. Node 24 strips types at load time, so there is no build
step for the server in development, and `tsc` here is a type checker only.

The rules that follow from that:

- **`npm run typecheck` must exit 0.** It is the whole type gate. There is no separate build to
  catch what it misses.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties. See
  [gotchas](gotchas.md).
- **Explicit `.ts`/`.tsx` extensions on relative imports**, server side.
- **Full `strict: true`.** Type the real shape rather than reaching for `any` or `@ts-ignore`.
  A type assertion is a claim you are making on the compiler's behalf, so it needs to be true.
- **`shared/types.ts` is the cross-boundary contract.** The server imports it relatively; the
  client imports it through the `@shared` alias.

The one real compile is `npm run prepack`, which emits `dist-server/` for publishing. Local
development never touches that path.

## Server

- **New endpoints join the existing app.** Add a route file under `server/routes/` exporting a
  `mount*` function, and call it from `server/api.ts`. Registered once, it works in dev and in
  `npm run standalone` identically.
- **Return token cells, never dollars.** The client prices from `src/models.ts`. A route that
  returns currency has put the price table on the wrong side of the wire.
- **Take a `Scope`** rather than writing an all-projects, a per-project and a per-session copy
  of the same query. `scopeClause()` and `minorGate()` do the rest.
- **Go through `calibrate.ts`** for any per-bucket token estimate, and mark the result `≈`.
- **Call `invalidateCache()`** from every path that writes.
- **Read-only on foreign systems.** Copy a SQLite source to temp with its sidecars; never open
  the live file. Never write a source log or a user's repo.
- **Back up before anything destructive**, and tombstone rather than drop.
- **Hold long-lived state on `globalThis`.** Watchers, timers and child processes survive a dev
  module reload only if they live there. See [gotchas](gotchas.md).

## Client

- **Plain React and one `styles.css`.** No UI framework. Charts are Recharts behind
  `src/charts/ChartWrapper.tsx`. Match the surrounding style rather than introducing a second
  one.
- **Shared vocabulary has one home.** Chat-type labels live only in `src/kinds.ts`; model
  prices and context windows only in `src/models.ts`. Add wording and numbers there.

## Verification

Green typecheck, tests and build before a PR goes up:

```bash
npm run typecheck
npm test
npm run build
```

While working, run the single test file you are changing rather than the whole suite, and run
the whole suite once at the end. `node --test test/<file>.test.mjs` runs one.

`npm run dev` is the fastest loop: the Express API is mounted inside the Vite dev server, so
the UI and the server modules both hot-reload in one process on one port.

### Beyond the suite

The unit tests cover parsers, engines and heuristics against fixtures. Features are verified
end to end against real data, and the fastest real-data check is to **import Chronicle's own
Claude Code sessions and click around**: time travel, causality and Insights all work on
Chronicle's own construction history.

`npm run test:e2e` drives the Playwright smoke suite against a seeded large fixture. It runs
fully parallel on two workers, each with its own seeded Chronicle instance, so a new spec must
not depend on another spec having run first; if it genuinely must, mark its file
`test.describe.configure({ mode: 'serial' })` and say why in a comment. A spec that passes only
on its retry fails the job as flaky rather than being quietly absorbed. CI splits the same
suite across three shards (`npm run test:e2e -- --shard=1/3`).
`npm run walk` runs the release walk against the surface contract in `spec/`.

When you add a source tool, validate against a fixture **and** a real session before opening
the PR. A parser that passes its fixture and fails on real data is the normal outcome, not the
surprising one.

### What a good test asserts

Something a user or an API client can observe: a route answers or returns 404, a page shows or
hides an element, a number reconciles with another number. Not internal module shape, which
pins the implementation and breaks on every honest refactor.

## Commands and gates

`package.json` scripts are the source of truth for every command, and `.github/workflows/` for
every gate. When a document disagrees with either, the file wins and the document is the bug to
fix. See [release](release.md).
