# ADR 0004: A flat five-kind event model is the ingestion contract

**Status:** Accepted

## Context

Chronicle imports from four tools whose logs agree on nothing. Claude Code and Codex write
JSONL; Cursor and OpenCode write SQLite. Each nests content differently, names roles
differently, and models tool calls differently.

Two shapes were available for the boundary between parsers and everything downstream.

**Preserve the source shape**, with a per-source view layer. Nothing is lost, and every
consumer downstream learns four dialects. Playback, search, causality, security scanning,
Insights, Explore and Content each grow a four-way branch, and adding a fifth tool touches all
of them.

**Flatten to one shape** at the parser. Downstream code sees one row type. The parser owns
every per-tool quirk, and anything the flat shape cannot express is dropped.

## Decision

Every parser returns a flat list of rows of one shape. `kind` is one of exactly five values:
`user`, `assistant`, `thinking`, `tool_use`, `tool_result`. `tool_use_id` is the join key
pairing a call with its result. The full row shape lives in `shared/types.ts`, which is the
single cross-boundary contract.

Adding a source means writing one parser and wiring it in three places. It means changing
nothing downstream. That is the whole point of the contract.

## Consequences

- Playback, search, causality, redaction and every analytics engine are written once.
- **The five kinds are a hard boundary.** A sixth kind is a schema change that touches every
  consumer, so a new concept is expressed as a column on the existing rows (the way
  `is_sidechain`, `agent_type` and `skill` were) rather than as a new kind.
- Source-native structure the flat shape cannot hold is lost at import. Where that structure
  matters it is promoted to a column, deliberately.
- Kind labels live only in `src/kinds.ts`, so the vocabulary cannot drift between the surfaces
  that render it.
- Import is a delete-and-reinsert of one session in a transaction, which makes re-import and
  incremental sync idempotent by construction rather than by careful bookkeeping.
