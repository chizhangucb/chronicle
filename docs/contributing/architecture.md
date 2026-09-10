# Architecture for contributors

[How it works](../architecture/how-it-works.md) is the system description: the data model,
ingestion, the Git engine, sync, the Insights engine, every route. Read it first.

This page is the layer above it. It covers the shape you have to keep, the decisions you are
not free to relitigate casually, and where the seams are.

## What Chronicle is

A session-review and pattern-analysis tool. It imports transcripts from four AI coding tools,
plays them back against Git history, analyses usage and prompt patterns, and redacts on export.

That is the whole product. Chronicle is independent: another tool may read Chronicle's data;
Chronicle never reads another tool's files. The only foreign data it touches is the source
tools' own logs and the user's Git repos, both read-only.

A feature that does not serve session review or pattern analysis does not belong here, no
matter how well it works. Proposing the removal of a module that has stopped earning its place
is a normal and welcome review finding.

## The load-bearing decisions

Each is written up in [`docs/adr/`](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/README.md): the context, the alternative it beat, and the cost accepted. The README there is the list. Read the one that touches your area before you change it.

### Facts that are not ADRs

Real and worth knowing, but reversible or unsurprising, so they live as doc lines rather than
decision records:

- The same Express **app** runs under Vite and standalone. Mount an app, not a Router
  ([gotchas](gotchas.md)).
- Native `.ts` in dev; a real compile only at `prepack` ([patterns](patterns.md)).
- A tag triggers an OIDC publish; the workflow file is the source of truth ([release](release.md)).
- The analytics cache is generation-keyed, invalidated rather than expired: every write path
  invalidates, with no exemptions.
- Live sessions stream over SSE.
- Deletes are tombstones.
- Routing is `wouter`; styling is one `styles.css`; sync is in-process.

## Principles that decide arguments

- **No LLM in the analysis path.** Every heuristic (redaction, durations, calibration, the
  noise gate) is local and deterministic, for cost and for run-to-run stability. `/ask` is
  the single, opt-in exception, and it spends the user's own subscription, never an API key.
- **Read-only on foreign systems.** Source logs and repos are never written. A SQLite source
  is copied to temp, sidecars included, before it is opened.
- **Destructive operations back up first**, and removal is a tombstone rather than a silent
  drop.
- **One source of truth per shared meaning.** Kind labels in `src/kinds.ts`, prices and
  context windows in `src/models.ts`, the cross-boundary types in `shared/types.ts`, the
  tool-result error heuristic in `server/errors.ts`. New wording and new numbers go in those
  files, never inline at a call site.

## The seams

A seam is where you can add or replace something without touching the rest. Chronicle has
four that matter.

**The parser seam.** A parser takes a tool-native log and returns `{ session, events }` in the
flat model. Everything downstream is written once. Adding a source touches the parser plus
three wiring points, and nothing else. The walkthrough is in
[How it works](../architecture/how-it-works.md#howto-add-a-new-source).

**The route seam.** Route groups live in `server/routes/` as `mount*` functions called from
`server/api.ts`. Register once and the endpoint works in dev and standalone identically.

**The scope seam.** `server/scope.ts` is the query context: `queryContext(scope, range)` hands
an engine its scope clause, its minor gate and its range fragments together, so one analytics
engine serves all three scopes and one range dialect. The minor gate is written there and
nowhere else (it applies everywhere except session scope). The three ranges are exposed by
name because they differ: a session is in range by overlap (`sessions()`), a message by its
timestamp (`messages()`), billed tokens by their in-range share (`tokens`). Every engine takes
`(scope, range)` — never a bare day count — rather than growing near-copies.

**The token/price seam.** The server returns cells; the client prices. See ADR 0005.

## Where to go next

- [Code map](code-map.md): what lives where.
- [Gotchas](gotchas.md): the traps that have already cost someone a day.
- [Patterns](patterns.md): the TypeScript rules and the verification loop.
- [Standards](standards.md): what a PR has to clear.
