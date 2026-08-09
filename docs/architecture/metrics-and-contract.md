# Metrics & Contract Views

Chronicle v0.2 turns the database into a **metrics substrate** external consumers can read: per-message token usage, sidechain (subagent) attribution, stored duration metrics, versioned SQL contract views, and an FTS5 full-text index. This page documents the schema additions and the contract an external reader can rely on.

The design constraint is the same as everywhere else in Chronicle: everything is computed locally at import time from the logs — no LLM calls, no network, and the base tables stay free to refactor because consumers read only the views.

## Sidechain & attribution columns (`messages`)

All additions are idempotent `ALTER TABLE` migrations in `server/db.js`, per the existing pattern.

| Column | Type | Set by | Meaning |
| --- | --- | --- | --- |
| `is_sidechain` | INTEGER (0/1) | all parsers | `1` = subagent/sidechain event. The Claude Code parser now **imports** sidechain lines instead of dropping them |
| `agent_type` | TEXT | Claude Code parser | Subagent type for sidechain rows (e.g. `Explore`, `general-purpose`), derived by pairing the sidechain's first user message with the main chain's `Task`/`Agent` `tool_use` input (`subagent_type`). `NULL` when unmatched or on main-chain rows |
| `skill` | TEXT | Claude Code parser | Active skill context: set on the `tool_use` row of a `Skill` call and on rows of a `<command-name>` turn, `NULL` elsewhere. Span-style "messages between invocation and next user turn" attribution is deliberately **not** attempted — too heuristic; consumers group per invocation instead |

`sessions` gains `sidechain_count` (a cheap denormalization for cards and analytics).

Scope rules worth knowing: `sessions.context_tokens` keeps its definition (last **main-chain** API call, matching Claude Code's own status line). Cost & Usage totals and Agent Active now **include** sidechains; default message counts, playback, and refine **exclude** them (UI filter on `is_sidechain = 0`).

## Per-message token columns (`messages`)

Five INTEGER columns on assistant rows: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_w5m_tokens`, `cache_w1h_tokens`.

One API call = one set of numbers, stored on the **first event of that call** (other events of the same call are `NULL`). This is what unlocks costliest-message rankings and dollar-weighted skill/tool attribution — the session-level `sessions.usage` JSON alone can't answer those. Sidechain usage is included (it was previously dropped entirely). Non-Claude parsers fill these where their logs carry usage; dollar costs remain consumer-side (static price tables, the `src/models.js` pattern) — **the database stores tokens, never dollars**.

## Duration metrics (stored on `sessions`)

Both metrics are computed at import time by a shared server module and stored, so the UI and the contract views read one number instead of re-deriving it client-side.

**`agent_active_ms`** — canonical "Agent Active". Sum over consecutive-message gaps (all rows, sidechains included, sorted by `ts` — a single per-timeline scan, so overlapping sidechain time isn't double-counted), where:

1. a gap leading into a **genuine human prompt** (the `SYNTHETIC_USER_RE` classifier — not every `user`-role row is human) → **excluded** entirely;
2. a gap ending in a `tool_result` matched to a prior `tool_use` → counted **in full** (real tool/build time, no cap);
3. permission-approval interactions → treated as human prompts (excluded);
4. all other gaps → counted, **capped at 10 minutes** each.

**`engaged_ms`** — "Engaged time", extension-style hands-on time: the sum of **all** inter-message gaps, each **capped at 90 minutes**, with no human/synthetic distinction.

The uncapped first-to-last span remains Total Duration. In the Overview, Agent Active keeps its stat card and Engaged time appears as a secondary line, each with its own ⓘ explainer.

## Contract views and `user_version`

External consumers (e.g. a dashboard) read **only** the `contract_*` views — a read-only **metrics** surface with **no content columns** (no message text, no tool input). Base tables can be refactored freely as long as the views keep their shape.

```sql
-- One row per message: metrics + pointers, NO content columns.
CREATE VIEW contract_message_metrics AS
SELECT m.session_id, m.seq, m.ts, m.kind, m.model,
       m.is_sidechain, m.agent_type, m.skill,
       m.tool_name,
       CASE WHEN m.tool_name LIKE 'mcp__%'
            THEN substr(m.tool_name, 6, instr(substr(m.tool_name, 6), '__') - 1)
       END AS mcp_server,
       m.input_tokens, m.output_tokens, m.cache_read_tokens,
       m.cache_w5m_tokens, m.cache_w1h_tokens,
       s.file_path AS source_file
FROM messages m JOIN sessions s ON s.id = m.session_id;

-- One row per session: identity, span, usage JSON, stored durations.
CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage,
       s.agent_active_ms, s.engaged_ms
FROM sessions s JOIN projects p ON p.id = s.project_id;
```

Rollups (per-skill, per-model, costliest messages) are derivable by the consumer from these two views; Chronicle does not pre-aggregate.

**Versioning contract:** `PRAGMA user_version = 1` is set at migration. It is bumped **only on breaking view changes** — additive columns don't bump it. A consumer must check `user_version` and **refuse loudly** on `0` or an unknown value rather than guessing at the shape.

## FTS5 full-text index

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```

An external-content FTS5 table over `messages.text` and `tool_input`. It is populated inside `replaceSession` — because import is a delete-and-reinsert of the whole session, rebuilding the session's FTS rows in the same transaction keeps the index consistent **without triggers**.

`GET /api/search` uses FTS5 `MATCH` with the same response shape as before, and **falls back to `LIKE`** if the FTS table is missing. Node's bundled SQLite includes FTS5; availability is verified at startup and the feature fails soft — search always works, FTS just makes it fast.

## Related

- [Data model](data-model.md) — the base tables these columns and views sit on, and `replaceSession`.
- [Session insights](../guide/session-insights.md) — the user-facing view of durations, cost, and usage.
- [Search & filtering](../guide/search-and-filtering.md) — the global search backed by the FTS5 index.
- [API reference](api-reference.md) — the `/api/search` route.
