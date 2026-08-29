# Chronicle product contract

Status: living · Owner: Chi Zhang · Location: `~/personal-projects/chronicle` (`chizhangucb/chronicle`, public, npm `chronicle-cli`) · License: Apache-2.0 (third-party notices in `NOTICE`)

## Purpose
A local-first session-data engine and operator console for your AI coding stack. It ingests your coding tools' transcripts into one local SQLite DB and serves session browsing, session-pattern analytics (Insights / Explore / Content), deterministic replay, security redaction, AND a set of hub-conditional ops surfaces over a nisse-format hub: Modules, Safety, Jobs, Briefing, and the V2 Nebula Memory graph, plus a confirm-first write gate. On-machine and heuristic: no LLM calls in the analysis path (the briefing / scope-suggest runners are user- or launchd-triggered headless Claude); the one outbound call is opt-out — the Claude plan-windows quota read to api.anthropic.com, on by default, off with a Settings toggle (Codex plan windows are local).

## Surfaces
- CLI (`npx chronicle-cli`, bins `chronicle`/`chronicle-cli`): runs the local web app in the foreground; `--port` (default 41730), `--no-open`. Node 24+. Setup subcommand `chronicle hub set|status|clear <path>` points the console at a nisse-format hub.
- Web UI (SPA routes): the analytics core `/`, `/projects`, `/project/:id`, `/session/:id` (`/insights` redirects to `/`), PLUS the hub-conditional ops routes `/modules`, `/safety`, `/jobs`, `/briefing`, `/memory` (rendered only when `/api/hub/status` reports present, i.e. a live hub or demo; hidden when absent). Exact enumerable shape lives in the surface contract.
- HTTP API: `http://127.0.0.1:<port>`, loopback only, `/api/*`. Consumed only by the app's own SPA. Includes the hub adapter (`/api/hub/{status,modules,safety,jobs,memory,codegraphs,...}`), the briefing (`/api/briefing*`), and the write gate (`/api/gate/*`: per-boot token, propose → validated diff card → confirm → backup → temp-rename write → verify → audit).
- Env knobs: `CHRONICLE_HUB` (primary public hub path), `AIOS_HUB`, `config.json hubRoot` (resolution order after `CHRONICLE_DEMO`), and `CHRONICLE_DEMO=1` (synthetic ops data for a zero-data user / fresh machine).
- DB read seam: the `contract_*` SQLite views (grandfathered sub-contract, see Internals), the only stable read interface. Gate audit lives in a self-created `gate_audit` table.
- `chronicle://session/<id>`: deep-link resolver for a session (`server/routes/sessions.ts`).
- Autosync: in-process incremental DB sync (server start, 30-min backstop, debounced fs-watch). Registered in hub `operations.md` as `chronicle-autosync`.

## Owned data
`~/.chronicle/chronicle.db` (SQLite, full message content): projects, sessions, messages, session tombstones, migrations. Source of truth for the imported session record; writes nowhere else, reads source logs read-only.

## Consumers
The human operator (browser console), now acting through gated writes as well as reads: the operator edits the hub egress posture, jobs, briefing state, and memory scope through the confirm-first gate, and Chronicle consumes a nisse-format hub as an adapter (read-only, titles/paths/counts only). Varde still reads the `contract_*` views only (`aggregator/sources/chronicle.ts`, `spend-chronicle.ts`) for its spend/session lanes during the no-flag-day rollout; Chronicle is an adapter Varde consumes, not a consumer of Varde.

## Internals
Two seams earn grandfathered sub-contracts (register, not rewrite); the rest covered here.

- **surface / IA contract** (`spec/surface-contract.md`): †grandfathered. The frozen product shape (routes, enumerables, per-surface inventory, e2e pins) with its own Change rule; the release walk's IA-conformance target.
- **contract_* DB views** (`server/db.ts`, `PRAGMA user_version`): †grandfathered. `contract_message_metrics` + `contract_sessions` are the stable read seam; base tables stay free to refactor. `user_version` = 1; a bump means a breaking view change, chronicle + Varde in one merge.
- **parsers** (`server/parsers/`): `claudeCode`, `codex`, `cursor`, `opencode`, four source clients, no sub-contract.
- **analysis engines + live SSE** (`server/insights.ts`, `explore.ts`, `content.ts`, `live.ts`): internal; shape owned by the surface contract.

## Non-goals
No cloud, account, auth, or telemetry. Never writes a source tool's data. Redaction is a share/export-boundary promise, not a claim about the local DB. Chronicle IS the aggregate multi-tool operator console (the ops surfaces), the role Varde is being decommissioned into.

## Invariants
CHI SIGN-OFF TO EDIT. Two HARD floors, everything else posture.

**Hard floors (never violated):**
- No telemetry ever: chronicle never phones home; there is no view-log or outbound analytics.
- Never mutate source transcripts: chronicle only ever reads a source tool's logs, and reads a connected nisse-format hub read-only (titles/paths/counts only, never body text, confidential/next-ventures pruned).

**Validated-seam writes (all writes go through one):**
- Every mutating route carries the per-boot gate token (same-origin/CSRF guard); the gate's own write surfaces run propose → validated diff → confirm → backup → temp-rename → post-write verify → audit; the briefing uses its two-file run-vs-UI split; hub writes shell the hub's `apply_edit.py` (or a direct-but-gated `hermes send` for the one Tier-2 surface). No raw file edits.
- The DB read seam is the `contract_*` views only; base tables are not public. `PRAGMA user_version` gates breaking view changes; a bump ships only with chronicle and Varde together.
- Share/export redaction runs before anything leaves the machine.
- IA/surface changes are gated by the surface contract's Change rule; drift without a signed edit is a publish-blocking P0.

**Posture (current, not locked):** binds loopback only (`127.0.0.1`); no LLM calls in the analysis path (the briefing / scope-suggest runners are user- or launchd-triggered headless Claude); no outbound network beyond the opt-out Claude-quota read and a hub the operator connects. The forward gate model is tiered auto-approval (reversible auto, irreversible confirm).

## Change triggers
Update this file in the same pass.
- A new source-client parser; a new `/api/*` or UI route; a new `contract_*` view column (with the `user_version` call).
- **Merge decided.** Varde merges into Chronicle; composed-not-merged is retired. Chronicle wins every identity slot; Varde's unique surfaces migrate in over a 4-phase, no-flag-day rollout. Each phase lands with a signed surface-contract revision and rewrites the affected sections here (Surfaces, Consumers, Non-goals).
- **Signed invariant architecture for the merged product** (applies as ported features land, per phase): hard floors = no telemetry ever + never mutate source transcripts; all other writes through validated seams (gated diff-first surfaces, hub append command); no-LLM-in-analysis-path, outbound scope, and loopback become posture, not invariants.
- **Cloud-scale moment.** If Chronicle plus Nisse reach online-platform scale, re-open go-to-market: identity, opt-in external telemetry, native shell, extraction questions.

## Pointers
In-repo: `README.md`, `docs/`, `spec/surface-contract.md`, `spec/design-qa-rubric.md`. Hub dev-knowledge and strategy: `$HUB/personal-projects/chronicle/`. Registry: hub `operations.md`; rationale: hub `records/decisions.jsonl` (session ledger `records/sessions.jsonl`).

## Roadmap
Only Now is a commitment.
- **Now:** release-walk hardening on the 1.3.x line.
- **Next:** Varde merge, 4 phases: port unique organs behind the nisse-hub adapter; consolidate spend/sessions; home merge + unified reference + demo mode + local view log; decommission Varde.
- **Later:** native desktop shell (deferred, bridge = PWA/dedicated window); cloud-platform exposure; contracts/registry rendered for a wider audience.
