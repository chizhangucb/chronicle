# Chronicle product contract

Status: living · Owner: Chi Zhang · Location: `~/personal-projects/chronicle` (`chizhangucb/chronicle`, public, npm `chronicle-cli`)

## Purpose
A local-first session-data engine and analysis console for your AI coding stack. It ingests your coding tools' transcripts into one local SQLite DB and serves session browsing, session-pattern analytics (Insights / Explore / Content), deterministic replay, and security redaction. On-machine and heuristic: no outbound network, no LLM calls.

## Surfaces
- CLI (`npx chronicle-cli`, bins `chronicle`/`chronicle-cli`): runs the local web app in the foreground; `--port` (default 41730), `--no-open`. Node 24+.
- Web UI (SPA routes): `/`, `/projects`, `/project/:id`, `/session/:id`; `/insights` redirects to `/`. Exact enumerable shape lives in the surface contract.
- HTTP API: `http://127.0.0.1:<port>`, loopback only, `/api/*`. Consumed only by the app's own SPA.
- DB read seam: the `contract_*` SQLite views (grandfathered sub-contract, see Internals), the only stable read interface.
- `chronicle://session/<id>`: deep-link resolver for a session (`server/routes/sessions.ts`).
- Autosync: in-process incremental DB sync (server start, 30-min backstop, debounced fs-watch). Registered in hub `operations.md` as `chronicle-autosync`.

## Owned data
`~/.chronicle/chronicle.db` (SQLite, full message content): projects, sessions, messages, session tombstones, migrations. Source of truth for the imported session record; writes nowhere else, reads source logs read-only.

## Consumers
The human operator (browser console). Varde reads the `contract_*` views only (`aggregator/sources/chronicle.ts`, `spend-chronicle.ts`) for its spend/session lanes. Chronicle is an adapter Varde consumes, not a consumer of Varde.

## Internals
Walked once (CHI-303). Two seams earn grandfathered sub-contracts (register, not rewrite); the rest covered here.

- **surface / IA contract** (`spec/surface-contract.md`): †grandfathered. The frozen product shape (routes, enumerables, per-surface inventory, e2e pins) with its own Change rule; the release walk's IA-conformance target.
- **contract_* DB views** (`server/db.ts`, `PRAGMA user_version`): †grandfathered. `contract_message_metrics` + `contract_sessions` are the stable read seam; base tables stay free to refactor. `user_version` = 1; a bump means a breaking view change, chronicle + Varde in one merge.
- **parsers** (`server/parsers/`): `claudeCode`, `codex`, `cursor`, `opencode`, four source clients, no sub-contract.
- **analysis engines + live SSE** (`server/insights.ts`, `explore.ts`, `content.ts`, `live.ts`): internal; shape owned by the surface contract.

## Non-goals
No cloud, account, auth, telemetry, or outbound calls. Never writes a source tool's data. Not an aggregate multi-tool console (Varde owns that). Redaction is a share/export-boundary promise, not a claim about the local DB.

## Invariants
CHI SIGN-OFF TO EDIT.
- No outbound network: chronicle never phones home.
- Read-only ingest: chronicle never mutates a source tool's logs.
- The DB read seam is the `contract_*` views only; base tables are not public.
- `PRAGMA user_version` gates breaking view changes; a bump ships only with chronicle and Varde together.
- Share/export redaction runs before anything leaves the machine.
- IA/surface changes are gated by the surface contract's Change rule; drift without a signed edit is a publish-blocking P0.

Current posture, not locked: binds loopback only (`127.0.0.1`); no LLM calls today.

## Change triggers
Update this file in the same pass.
- A new source-client parser; a new `/api/*` or UI route; a new `contract_*` view column (with the `user_version` call).
- **Merge decided (CHI-307, 2026-08-25).** Varde merges into Chronicle; composed-not-merged is retired. Chronicle wins every identity slot; Varde's unique surfaces migrate in over a 4-phase, no-flag-day rollout. Each phase lands with a signed surface-contract revision and rewrites the affected sections here (Surfaces, Consumers, Non-goals).
- **Signed invariant architecture for the merged product** (applies as ported features land, per phase): hard floors = no telemetry ever + never mutate source transcripts; all other writes through validated seams (gated diff-first surfaces, hub append command); no-LLM-in-analysis-path, outbound scope, and loopback become posture, not invariants. Rationale: decisions ledger 2026-08-25 (session 46f0f484).
- **Cloud-scale moment.** If Chronicle plus Nisse reach online-platform scale, re-open go-to-market: identity, opt-in external telemetry, native shell, extraction questions.

## Pointers
In-repo: `README.md`, `docs/`, `spec/surface-contract.md`, `spec/design-qa-rubric.md`. Hub dev-knowledge and strategy: `$HUB/personal-projects/chronicle/`. Registry: hub `operations.md`; rationale: `records/decisions.md`.

## Roadmap
Only Now is a commitment.
- **Now:** release-walk hardening on the 1.3.x line (CHI-310).
- **Next:** Varde merge, 4 phases: port unique organs behind the nisse-hub adapter; consolidate spend/sessions; home merge + unified reference + demo mode + local view log; decommission Varde (CHI-307 decision, merge parent in the Chronicle Linear project).
- **Later:** native desktop shell (deferred, bridge = PWA/dedicated window); cloud-platform exposure; contracts/registry rendered for a wider audience.
