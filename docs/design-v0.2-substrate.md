# Chronicle v0.2 Substrate Upgrade — Design Doc (for review)

Status: **APPROVED by Chi, 2026-08-09** (all open questions resolved)
Source decisions: `~/chizhang-2/records/brainstorms/2026-08-09-chronicle-big-upgrade.md`
Tickets: CHI-122, CHI-129 (rewritten), CHI-136–143

Chronicle becomes the metrics substrate for aios-dashboard while staying a standalone product. Three phases, executed in order; the one-time catch-up import runs only after all Phase 1 schema changes land, so historical data is imported once under the final schema.

---

## Phase 1 — Schema & parsers

### 1.1 New `messages` columns

Idempotent `ALTER TABLE` migrations (existing pattern in `server/db.js`):

| column | type | set by | notes |
|---|---|---|---|
| `is_sidechain` | INTEGER (0/1) | all parsers | 1 = subagent/sidechain event. CC parser stops dropping `isSidechain` lines. |
| `agent_type` | TEXT | CC parser | Subagent type for sidechain rows (e.g. `Explore`, `general-purpose`). Derived by pairing the sidechain's first user message with the main chain's `Task`/`Agent` `tool_use` input (`subagent_type` field). NULL when unmatched or on main-chain rows. |
| `skill` | TEXT | CC parser | Active skill context. Set on the `tool_use` row of a `Skill` call and on rows of a `<command-name>` turn; NULL elsewhere. Attribution = "messages between skill invocation and next user turn" is deliberately NOT attempted (too heuristic); the view exposes per-invocation grouping instead. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_w5m_tokens`, `cache_w1h_tokens` | INTEGER | all parsers that have usage | **Per-message usage** on assistant rows (one API call = one set of numbers; stored on the first event of that call, others NULL). Unlocks costliest-messages, $-weighted skill/tool attribution — session-level `sessions.usage` JSON alone can't do these. Sidechain usage included (previously dropped entirely). |

`sessions` gains `sidechain_count` INTEGER (cheap denormalization for cards/analytics).

Sidechain scope note: `sessions.context_tokens` keeps its current definition (last **main-chain** call — matches Claude Code's own status line). Cost & Usage totals and Agent Active now INCLUDE sidechains; default message counts / playback / refine EXCLUDE them (UI filter on `is_sidechain = 0`).

### 1.2 Contract views (`contract_*`) + versioning

The dashboard reads ONLY these views; base tables remain free to refactor. `PRAGMA user_version = 1` set at migration; bump only on breaking view changes; consumers must refuse `0`/unknown loudly.

```sql
-- One row per message. Metrics + pointers, NO content columns.
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

-- One row per session: identity, span, usage JSON, derived durations.
CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage,
       s.agent_active_ms, s.engaged_ms;    -- see 1.3; stored, not computed in-view
```

(Exact column list is the review surface — flag anything missing for the dashboard aggregator. `costliest` rankings, per-skill/per-model rollups are derivable by the consumer from these two; we don't pre-aggregate in views.)

Dollar costs remain consumer-side (static price tables, `src/models.js` pattern) — the DB stores tokens, never dollars. Lane C (real-dollar spend JSONL) is CHI-139, out of scope here.

### 1.3 Duration metrics (computed at import, stored on `sessions`)

Both currently live client-side (`SessionView.activeDurationMs`); they move to a shared server module so import stores them and the UI + views read one number.

**`agent_active_ms`** (canonical "Agent Active", 8/6-amended definition):
sum over consecutive-message gaps where:
1. gap into a **genuine human prompt** (existing `SYNTHETIC_USER_RE` classifier) → excluded entirely;
2. gap ending in a `tool_result` matched to a prior `tool_use` → counted in FULL (real tool/build time, no cap);
3. permission-approval interactions → treated as human (excluded) — detectable as human-prompt rows; no new machinery;
4. all other gaps → counted, **capped at 10 min** each.
Sidechain rows participate (their gaps overlap main-chain time; the sum stays a per-timeline scan over ALL rows sorted by ts, so overlap doesn't double-count).

**`engaged_ms`** ("Engaged time", extension-style): sum of ALL inter-message gaps, each capped at 90 min. No human/synthetic distinction.

UI: Overview stat card keeps the label **Agent Active** with updated InfoTip text; Engaged time appears as a secondary line **with its own InfoTip** (explaining the 90-min-cap "hands-on time" semantics, and how it differs from Agent Active). Both InfoTips: key = full English sentence, add zh/ja dict entries; `.info-bubble` opens downward per the existing rule. Uncapped span = existing Total.

### 1.4 FTS5

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```
Populated inside `replaceSession` (delete+reinsert keeps it consistent; no triggers needed). `/api/search` switches from `LIKE` to FTS5 `MATCH` with the same response shape; falls back to LIKE if the FTS table is missing. Node's bundled SQLite includes FTS5 (verify at startup, fail soft).

### 1.5 Parser upkeep

Verify all 6 parsers against current log formats (formats drift while paused); fixtures updated. Codex/Cursor/OpenCode/Gemini/Copilot get `is_sidechain=0` and per-message usage where their logs carry it; no new extraction beyond that (skill/agent_type are CC-only concepts for now).

---

## Phase 2 — Freshness

- **Tray auto-sync**: on server start + on system wake (`powerMonitor.on('resume')` — covers macOS dropping fs-watch events across sleep, the main watcher-failure mode) + every 30 min (backstop timer) + fs-watch on known source dirs, run incremental sync (re-import sessions whose file mtime > last import). Settings: auto-sync on/off, launch-at-login (macOS `app.setLoginItemSettings`). Reuses `POST /api/sessions/:id/sync` internals; state on `globalThis` per the SSR-reload pattern.
- **In-progress sessions**: synced like any other — `replaceSession` is idempotent delete+reinsert, so a partial import is simply superseded by the next pass; no quiesce window (skipping active files would keep the current session perpetually stale). fs-watch is debounced (~30 s after last write) so a streaming JSONL isn't re-imported per line; the 30-min timer is the backstop for missed events. Sessions whose source mtime is recent (<10 min) render as **ongoing** in the UI (active indicator; stats labeled "so far"). Live SSE remains the real-time view; auto-sync is durability, not liveness.
- **`chronicle://session/<id>`**: Electron `setAsDefaultProtocolClient` + open-url handler → focus window, navigate to SessionView. Dashboard deep-links use it, falling back to showing `file_path`.
- **One-time catch-up import** (LAST): full re-import of all sources (everything since 2026-07-21 + re-import of existing 81 sessions so they gain sidechains/per-message usage/durations). `replaceSession` already preserves user-set names. Expected DB ≈ 250–400 MB.

## Phase 3 — Trim + polish

- Delete MCP Hub (`server/mcp/`, `/mcp` mount, UI), Skills Hub (`server/skills.js`, watcher, UI), guard hook (`hooks/`, install UI). Keep: security scan/redaction, sharing, tray (repurposed: auto-sync). Sidebar bottom row shrinks to Security / Feedback / Collapse.
- Session-list scale UX (CHI-137): sort (recency/cost/duration), filter (source/date), windowed lists.
- Ship **v0.2.0** (feature removals ⇒ minor bump; release checklist as in CLAUDE.md). Then CHI-143: docs (en/zh/ja) + getchronicle.dev update — remove trimmed features, add auto-sync/contract/metrics/FTS5 pages.

---

## Execution & verification

- Branch + PR per phase (`feat/v0.2-schema`, `feat/v0.2-freshness`, `feat/v0.2-trim`), fresh session each, this doc as the spec.
- Verify Phase 1 the usual way: re-import Chronicle's own session, check sidechain rows/agent_type/skill/per-message tokens in sqlite, compare Agent Active vs the old client-side number on a known session (the 43m reference session), FTS5 search parity spot-checks.
- Phase 2: kill app, touch a JSONL, relaunch → session updates without manual sync; `open chronicle://session/<id>`.
- Phase 3: `npm run dist:mac` green; grep bundle for removed modules.

## Review resolutions (2026-08-09, Chi)

1. Per-message token columns (1.1): **approved.**
2. Durations stored on `sessions` at import (1.3): **approved.**
3. Skill attribution per-invocation only, no span heuristics (1.1): **approved.**
4. Auto-sync cadence: **30-min backstop timer + fs-watch + sync-on-wake** (`powerMonitor` resume). Engaged time gets its own InfoTip; in-progress sessions sync idempotently with an "ongoing" indicator.
