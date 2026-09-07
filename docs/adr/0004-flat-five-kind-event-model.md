# ADR 0004: A flat five-kind event model is the ingestion contract

Four tools whose logs agree on nothing (JSONL for Claude Code and Codex, SQLite for Cursor and OpenCode). Every parser flattens to one row shape, defined in `shared/types.ts`, with `kind` one of exactly `user`, `assistant`, `thinking`, `tool_use`, `tool_result` and `tool_use_id` joining a call to its result. Rejected: preserving each source's shape behind a per-source view, which gives every downstream consumer four dialects and makes a fifth tool touch all of them.

## Consequences

- Playback, search, redaction and every analytics engine are written once. Adding a source is one parser.
- The five kinds are a hard boundary. A new concept becomes a column on existing rows (as `is_sidechain`, `agent_type`, `skill` did), never a sixth kind.
- Source-native structure the flat shape cannot hold is lost at import, or promoted to a column on purpose.
- Kind labels live only in `src/kinds.ts`.
- Import is a delete-and-reinsert of one session in a transaction, so re-import and incremental sync are idempotent by construction.
