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

## The seven load-bearing decisions

Each is written up in [`docs/adr/`](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/README.md), with its context, its trade-off, and
the cost that was accepted. Read the one that touches your area before you change it.

1. [No native modules](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0001-no-native-modules.md). `node:sqlite`, git via `execFile`,
   Node 24 floor.
2. [Git history is the only source of code state](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0002-git-is-the-only-code-state.md).
   No snapshot store, never current disk.
3. [Redaction runs at the export boundary](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0003-redaction-at-the-export-boundary.md).
   The local database holds full content so playback is faithful.
4. [A flat five-kind event model](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0004-flat-five-kind-event-model.md) is the ingestion
   contract across all four tools.
5. [The server ships token cells; the client prices them](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0005-server-ships-tokens-client-prices.md).
6. [Per-bucket tokens are calibrated from text share](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0006-token-calibration-by-text-share.md),
   marked with `≈`.
7. [`/ask`: a read-only SQLite handle is the security boundary](https://github.com/chizhangucb/chronicle/blob/main/docs/adr/0007-ask-read-only-handle-is-the-boundary.md).

### Facts that are not ADRs

Real and worth knowing, but reversible or unsurprising, so they live as doc lines rather than
decision records:

- The same Express **app** runs under Vite and standalone. Mount an app, not a Router
  ([gotchas](gotchas.md)).
- Native `.ts` in dev; a real compile only at `prepack` ([patterns](patterns.md)).
- A tag triggers an OIDC publish; the workflow file is the source of truth ([release](release.md)).
- The analytics cache is generation-keyed, invalidated rather than expired, with the view log
  exempt from invalidation.
- Live sessions stream over SSE.
- Deletes are tombstones.
- Routing is `wouter`; styling is one `styles.css`; sync is in-process.

## Principles that decide arguments

- **No LLM in the analysis path.** Every heuristic (causality, redaction, durations,
  calibration, the noise gate) is local and deterministic, for cost and for run-to-run
  stability. `/ask` is the single, opt-in exception, and it spends the user's own
  subscription, never an API key.
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

**The scope seam.** `server/scope.ts` turns `{ type: 'all' | 'project' | 'session', id }` into
a SQL fragment, so one analytics engine serves all three scopes. `minorGate()` applies the
noise-gate exclusion everywhere except session scope. A new engine takes a `Scope` rather than
growing three near-copies.

**The token/price seam.** The server returns cells; the client prices. See ADR 0005.

## Where to go next

- [Code map](code-map.md): what lives where.
- [Gotchas](gotchas.md): the traps that have already cost someone a day.
- [Patterns](patterns.md): the TypeScript rules and the verification loop.
- [Standards](standards.md): what a PR has to clear.
