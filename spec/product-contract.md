# Chronicle product contract

Status: living · Owner: Chi Zhang · Location: `~/personal-projects/chronicle` (`chizhangucb/chronicle`, public, npm `chronicle-cli`) · License: Apache-2.0 (third-party notices in `NOTICE`)

## Purpose
A local-first session-data engine and operator console for your AI coding stack. It ingests your coding tools' transcripts into one local SQLite DB and serves session browsing, session-pattern analytics (Insights / Explore / Content), deterministic replay, security redaction, AND a set of hub-conditional ops surfaces over a nisse-format hub: Modules, Safety, Jobs, Briefing, and the V2 Nebula Memory graph, plus a tiered write gate. On-machine and heuristic: no LLM calls in the analysis path (the briefing / scope-suggest runners are user- or launchd-triggered headless Claude); the one outbound call is opt-out — the Claude plan-windows quota read to api.anthropic.com, on by default, off with a Settings toggle (Codex plan windows are local).

## Surfaces
- CLI (`npx chronicle-cli`, bins `chronicle`/`chronicle-cli`): runs the local web app in the foreground; `--port` (default 41730), `--no-open`. Node 24+. Setup subcommand `chronicle hub set|status|clear <path>` points the console at a nisse-format hub.
- Web UI (SPA routes): the analytics core `/`, `/projects`, `/project/:id`, `/session/:id` (`/insights` redirects to `/`), PLUS the hub-conditional ops routes `/modules`, `/safety`, `/jobs`, `/briefing`, `/memory` (rendered only when `/api/hub/status` reports present, i.e. a live hub or demo; hidden when absent). Exact enumerable shape lives in the surface contract.
- HTTP API: `http://127.0.0.1:<port>`, loopback only, `/api/*`. Consumed only by the app's own SPA. Includes the hub adapter (`/api/hub/{status,modules,safety,jobs,memory,codegraphs,...}`), the briefing (`/api/briefing*`), and the write gate (`/api/gate/*`: per-boot token, then either an auto-applied write or propose → validated diff card → confirm, both ending backup → temp-rename write → verify → audit; plus `/api/gate/undo`).
- Env knobs: `CHRONICLE_HUB` (primary public hub path), `AIOS_HUB`, `config.json hubRoot` (resolution order after `CHRONICLE_DEMO`), and `CHRONICLE_DEMO=1` (synthetic ops data for a zero-data user / fresh machine).
- DB read seam: the base tables in `chronicle.db`, taken as they are. There is no compatibility view layer and no version pragma over one; a reader accepts that the tables may be reshaped without notice. Gate audit lives in a self-created `gate_audit` table.
- `chronicle://session/<id>`: deep-link resolver for a session (`server/routes/sessions.ts`).
- Autosync: in-process incremental DB sync (server start, 30-min backstop, debounced fs-watch). Registered in hub `operations.md` as `chronicle-autosync`.

## Owned data
`~/.chronicle/chronicle.db` (SQLite, full message content): projects, sessions, messages, session tombstones, migrations. Source of truth for the imported session record; writes nowhere else, reads source logs read-only.

## Consumers
The human operator (browser console), now acting through gated writes as well as reads: the operator edits the hub egress posture, jobs, briefing state, and memory scope through the tiered gate, and Chronicle consumes a nisse-format hub as an adapter (read-only, titles/paths/counts only). The former Varde console (the only external consumer the DB ever had) is decommissioned; nothing outside this repo reads chronicle.db.

## Internals
One seam earns a grandfathered sub-contract (register, not rewrite); the rest covered here.

- **surface / IA contract** (`spec/surface-contract.md`): †grandfathered. The frozen product shape (routes, enumerables, per-surface inventory, e2e pins) with its own Change rule; the release walk's IA-conformance target.
- **parsers** (`server/parsers/`): `claudeCode`, `codex`, `cursor`, `opencode`, four source clients, no sub-contract.
- **analysis engines + live SSE** (`server/insights.ts`, `explore.ts`, `content.ts`, `live.ts`): internal; shape owned by the surface contract.

## Non-goals
No cloud, account, auth, or telemetry. Never writes a source tool's data. Redaction is a share/export-boundary promise, not a claim about the local DB. Chronicle IS the aggregate multi-tool operator console (the ops surfaces), the role it absorbed from the now-decommissioned Varde.

## Invariants
CHI SIGN-OFF TO EDIT. Two HARD floors, everything else posture.

**Hard floors (never violated):**
- No telemetry ever: chronicle never phones home; there is no view-log or outbound analytics.
- Never mutate source transcripts: chronicle only ever reads a source tool's logs, and reads a connected nisse-format hub read-only (titles/paths/counts only, never body text, confidential trees pruned).

**Validated-seam writes (all writes go through one):**
- Every mutating route carries the per-boot gate token (same-origin/CSRF guard); the gate's own write surfaces run backup → temp-rename → post-write verify → audit, behind a confirm card unless the surface declares `approval: 'auto'` (absent means confirm; the floors that can never auto live in `core.ts`, not the registry); the briefing uses its two-file run-vs-UI split; hub writes go through the hub's own gated entry point. No raw file edits.
- Share/export redaction runs before anything leaves the machine.
- IA/surface changes are gated by the surface contract's Change rule; drift without a signed edit is a publish-blocking P0.

**Posture (current, not locked):** binds loopback only (`127.0.0.1`); no LLM calls in the analysis path (the briefing / scope-suggest runners are user- or launchd-triggered headless Claude); no outbound network beyond the opt-out Claude-quota read and a hub the operator connects. The gate model is tiered auto-approval on a reversibility bar: reversible Chronicle-owned state applies automatically; the egress gate's own config, Hermes approvals, and anything model-generated confirm. Every auto write is listed with an Undo on `/safety`.

## Change triggers
Update this file in the same pass.
- A new source-client parser; a new `/api/*` or UI route.
- **Merge shipped.** Varde merged into Chronicle at parity and was decommissioned; composed-not-merged retired. Chronicle won every identity slot over a 4-phase, no-flag-day rollout, each phase landing a signed surface-contract revision.
- **Signed invariant architecture for the merged product** (landed across the 4 phases): hard floors = no telemetry ever + never mutate source transcripts; all other writes through validated seams (gated diff-first surfaces, hub append command); no-LLM-in-analysis-path, outbound scope, and loopback become posture, not invariants.
- **Cloud-scale moment.** If Chronicle plus Nisse reach online-platform scale, re-open go-to-market: identity, opt-in external telemetry, native shell, extraction questions.

## Pointers
In-repo: `README.md`, `docs/`, `spec/surface-contract.md`, `spec/design-qa-rubric.md`. Hub dev-knowledge and strategy: `$HUB/personal-projects/chronicle/`. Registry: hub `operations.md`; rationale: hub `records/decisions.jsonl` (session ledger `records/sessions.jsonl`).

## Roadmap
Only Now is a commitment.
- **Now:** release-walk hardening on the 1.3.x line.
- **Next:** open. The 4-phase Varde merge that sat here has shipped: unique organs ported behind the nisse-hub adapter, spend/sessions consolidated, home merge + unified reference + demo mode + local view log, Varde decommissioned.
- **Later:** native desktop shell (deferred, bridge = PWA/dedicated window); cloud-platform exposure; contracts/registry rendered for a wider audience.
