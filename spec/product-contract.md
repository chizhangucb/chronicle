# Chronicle product contract

Status: living · Owner: Chi Zhang · Location: `~/personal-projects/chronicle` (`chizhangucb/chronicle`, public, npm `chronicle-cli`) · License: Apache-2.0 (third-party notices in `NOTICE`)

## Purpose
A local-first session-data engine for your AI coding stack. It ingests your coding tools' transcripts into one local SQLite DB and serves session browsing, session-pattern analytics (Insights / Explore / Content / Spend / Sessions), deterministic replay, security redaction and redacted export, and /ask. On-machine and heuristic: no model call in the analysis path. The one model run in the product is /ask, opt-in off by default, an operator-initiated local `claude -p` on the operator's own Claude subscription. The one outbound call is opt-out — the Claude plan-windows quota read to api.anthropic.com, on by default, off with a Settings toggle (Codex plan windows are local).

## Surfaces
- CLI (`npx chronicle-cli`, bins `chronicle`/`chronicle-cli`): runs the local web app in the foreground; `--port` (default 41730), `--no-open`, `--demo`, `--app`. Node 24+. No subcommands.
- Web UI (SPA routes): `/`, `/projects`, `/project/:id`, `/session/:id`, `/reference`, `/ask` (`/insights` redirects to `/`). `/ask` renders only when its Settings toggle is on, the claude CLI is present and the console is non-demo; otherwise it fails soft. There are no other routes, and no route is conditional on anything outside Chronicle's own data folder. Exact enumerable shape lives in the surface contract.
- HTTP API: `http://127.0.0.1:<port>`, loopback only, `/api/*`. Consumed only by the app's own SPA. Mutating routes carry a per-boot write token as a same-origin guard, and nothing more.
- Env knobs: `CHRONICLE_DATA_DIR` (where the data folder lives) and `CHRONICLE_DEMO=1` (synthetic sessions and projects for a zero-data user / fresh machine). No env var or config key names a path outside Chronicle's own folder, the source tools' logs and the operator's git repos.
- DB read seam: the base tables in `chronicle.db`, taken as they are. There is no compatibility view layer and no version pragma over one; a reader accepts that the tables may be reshaped without notice.
- `chronicle://session/<id>`: deep-link resolver for a session (`server/routes/sessions.ts`).
- Autosync: in-process incremental DB sync (server start, 30-min backstop, debounced fs-watch).

## Owned data
`~/.chronicle/chronicle.db` (SQLite, full message content): projects, sessions, messages, session tombstones, migrations. Source of truth for the imported session record; writes nowhere else, reads source logs read-only.

## Consumers
The human operator, through the browser console, reading and editing Chronicle's own records (rename, unlink, delete, settings, redaction rules). Nothing outside this repo reads `chronicle.db` today.

**Direction of data.** Chronicle owns its data folder and reads the source tools' logs and the operator's git repos read-only. It reads no file belonging to another project. Any future integration with another tool is that tool reading Chronicle's data, never Chronicle reading that tool's files.

## Internals
One seam earns a grandfathered sub-contract (register, not rewrite); the rest covered here.

- **surface / IA contract** (`spec/surface-contract.md`): †grandfathered. The frozen product shape (routes, enumerables, per-surface inventory, e2e pins) with its own Change rule; the release walk's IA-conformance target.
- **parsers** (`server/parsers/`): `claudeCode`, `codex`, `cursor`, `opencode`, four source clients, no sub-contract.
- **analysis engines + live SSE** (`server/insights.ts`, `explore.ts`, `content.ts`, `live.ts`): internal; shape owned by the surface contract.

## Non-goals
No cloud, account, auth, or telemetry. Never writes a source tool's data. Redaction is a share/export-boundary promise, not a claim about the local DB. Chronicle is a session-analysis tool, not an operator console over a machine: it does not read another project's configuration, schedule jobs, gate egress, or launch other programs.

## Invariants
CHI SIGN-OFF TO EDIT. Two HARD floors, everything else posture.

**Hard floors (never violated):**
- No telemetry ever: chronicle never phones home; there is no view-log or outbound analytics.
- Never mutate source transcripts: chronicle only ever reads a source tool's logs, and reads nothing belonging to another project.

**Guarded writes:**
- Every mutating route carries the per-boot write token (a same-origin/CSRF guard, `server/writeToken.ts`). It is the whole of the mutation guard: there is no propose step, no diff card, no backup-and-verify ritual, no audit table and no undo. Chronicle writes only its own data folder.
- Share/export redaction runs before anything leaves the machine.
- IA/surface changes are gated by the surface contract's Change rule; drift without a signed edit is a publish-blocking P0.

**Posture (current, not locked):** binds loopback only (`127.0.0.1`); no model call in the analysis path; the one model run is /ask, opt-in off by default, spawned locally on the operator's own subscription and confined to a single read-only SELECT-only handle on `chronicle.db`; no outbound network beyond the opt-out Claude-quota read.

## Change triggers
Update this file in the same pass.
- A new source-client parser; a new `/api/*` or UI route.
- **Shrink shipped** (spec #215). Chronicle is a session-analysis tool and nothing else. The ops surfaces (Modules, Safety, Jobs, Briefing, Memory, Records), the external-checkout adapter, the tiered write gate, the Terminal launcher, the proxy spend lane, the machine-sessions manifest, the contract database views and the retired CLI subcommand are removed. Chronicle is independent: it reads only its own data folder, the source tools' logs and the operator's git repos.
- **Signed invariant architecture**: hard floors = no telemetry ever + never mutate source transcripts; mutating routes carry the per-boot write token; no-model-in-analysis-path, outbound scope and loopback are posture, not invariants.
- **Cloud-scale moment.** If Chronicle reaches online-platform scale, re-open go-to-market: identity, opt-in external telemetry, native shell, extraction questions.

## Pointers
In-repo: `README.md`, `docs/`, `spec/surface-contract.md`, `spec/design-qa-rubric.md`, `docs/adr/`. Work and rationale are tracked as GitHub issues on `chizhangucb/chronicle` (see `docs/agents/issue-tracker.md`).

## Roadmap
Only Now is a commitment.
- **Now:** finish the shrink (spec #215) and the standalone restructure (#173): vocabulary sweep, CONTEXT.md, the codebase-design pass.
- **Next:** open.
- **Later:** native desktop shell (deferred, bridge = PWA/dedicated window); cloud-platform exposure; contracts rendered for a wider audience.
