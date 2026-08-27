# Chronicle

Local-first AI coding session manager ("time machine"): imports logs from 4 AI tools (Claude Code, Codex, Cursor, OpenCode), maps every message to a Git code snapshot, adds security redaction, live streaming, and a tabbed Insights analytics home (Overview/Explore/Content) with first-class Subagents. Ships as a local web app via `npx chronicle-cli` (Node 24+): no desktop shell, no cloud, no telemetry. The one outbound call is opt-out (CHI-324 2f/D7): the Claude plan-windows feature reads your own subscription quota from api.anthropic.com, on by default, off with one Settings toggle; Codex plan windows are read locally. Everything heavy is heuristic and local; there are no LLM calls anywhere.

Satellite of the AIOS hub; owning project folder: `personal-projects/chronicle`. Canonical pattern rules: `$HUB/governance/satellite-repos.md`. Binding per-repo contract: `$HUB/governance/repo-contract.md`. Registry row: `$HUB/operations.md` `## Satellites`. `$HUB` = `$AIOS_HUB` (default `~/chizhang-2`).

This file is a map: each line points at a source of truth, nothing restated (`repo-contract.md`). Deep dev knowledge lives in the hub, linked below. Docs site (guide/reference/architecture): `docs/`, published at getchronicle.dev/docs. Feature summary: `README.md`.

## Commands

```bash
npm run dev        # Vite dev server + API in one process → http://localhost:4173
npm run build      # vite build → dist/
npm run typecheck  # tsc -b  (type gate: MUST exit 0)
npm test           # node --test 'test/**/*.test.mjs'
npm run test:e2e   # playwright E2E gate (function/overflow/data-scale/perf smoke)
npm run walk       # release-walk capture (screenshots + probe JSON), judged against spec/
```

`npx chronicle-cli` runs the published build. CI (`.github/workflows/ci.yml`) gates `main` and every PR on typecheck + test + build + the Playwright E2E job, on Node 24. Full publish/TypeScript/architecture detail is in the hub dev docs below.

## Repo layout

`src/`, `server/`, `shared/`, `scripts/`, `test/`, `spec/`, `docs/`, `dist/` follow the standard product vocabulary (`repo-contract.md`); `shared/` holds the client+server TypeScript types. Components beyond the vocabulary, declared here so the contract's vocabulary check passes:

- `website/`: the self-contained Vercel marketing site (getchronicle.dev), its own `package.json` and build, deployed separately from the app. Stays in-repo for now; revisit if it grows into its own repo (CHI-209 D2).
- `bin/`: the npm entrypoint (`bin/chronicle.mjs`, what `npx chronicle-cli` runs).
- `index.html`: the Vite entry for the app.

## Hub link

- Hub is read-only from runtime code; path comes from `AIOS_HUB` (default `~/chizhang-2`). No absolute machine paths in tracked files (path-relative + git-cloneable).
- `AGENTS.md` is `CLAUDE.md`'s twin: same content via symlink, so any harness reads this floor.
- Confidentiality floor: chronicle is PUBLIC. Nothing confidential (hub `wiki/confidential/`, `next-ventures/`, or equivalent) ever lands in this repo's files, fixtures, commits, or pushes. Fixtures are always synthetic, never copies of hub data. Sessions may read anything in the hub.

## Floor: $HUB/governance/ pointers

The always-loaded floor is the working rules below plus this pointer table; governance bodies load on demand, never all at once.

| Topic | Source of truth |
|---|---|
| Repo layout + floor | `$HUB/governance/repo-contract.md` |
| Satellite boundary, records, push, egress | `$HUB/governance/satellite-repos.md` |
| Confidentiality (never leaves) | `$HUB/governance/confidentiality.md` |
| Ticket lifecycle (all repos) | `$HUB/governance/ticket-tracker.md` |
| Writing for Chi | `$HUB/governance/communication-style.md` |
| Skill authoring + budgets | `$HUB/governance/skill-authoring.md` |

## Working rules

- Plan-first for anything non-trivial; the plan gets a yes before build.
- No em dashes, anywhere, including files. Concise, bullets, casual, no hype.
- Commits free as work completes; push is confirm-first, always.
- Branch + PR for non-trivial changes; reserve direct-to-`main` for trivial/agreed one-offs. After a squash-merge, return the local checkout to freshly-pulled `main` before branching next (squash-merge leaves stale head branches; confirm a merged PR, not `is-ancestor`, before deleting).
- STANDING RULE (bug-sweep): any user-reported fix targeting a UI/UX pattern class MUST trigger an app-wide sweep for that same pattern, with a regression pin (new CI probe or test assertion) landed in the same PR. A sweep is one grep/search pass; the probe is the durable guard.
- Surface reshaping (new/merged/moved/redesigned page, or any change to a route/surface/enumerable) needs a matching `spec/surface-contract.md` edit + Chi's sign-off, and a screenshot for Chi before the batch merges. IA drift without a signed contract edit is a publish-blocking P0.
- npm publish is TAG-TRIGGERED, not a command you run. `.github/workflows/publish.yml` publishes via OIDC trusted publishing when a `vX.Y.Z` tag lands; it is the source of truth for this flow, so read it before any release. Order: bump `package.json` version **and `CHANGELOG.md`** (same PR) → merge → confirm `main` green → `npm run walk` against real data, judge against `spec/design-qa-rubric.md` + `spec/surface-contract.md` (publish blocks on any open P0/P1) → `git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z` → the workflow gates and publishes → verify `npm view chronicle-cli version` → clean-dir npx smoke → `gh release create vX.Y.Z` (title = bare `vX.Y.Z`, matching every prior release). Running `npm publish` by hand still works but is the FALLBACK: it demands a WebAuthn passkey ceremony, emits no provenance attestation, and leaves the tag's workflow run failing on a version that already exists. Full checklist: hub patterns doc below.

## Pre-push scan list

Chronicle is public. Before any push, verify:
- No hub-confidential material: nothing from `wiki/confidential/`, `next-ventures/`, or acquisition-adjacent trees.
- No real hub documents or data in fixtures or tests (synthetic only).
- No absolute hub/home paths in tracked files.
- No secrets, keys, or `.env` contents.

Deeper hub-data scan is deferred until chronicle reads hub data at runtime (CHI-107); it does not today, so it cannot carry hub-confidential data. Standard push confirm-first still applies.

## Records seam

No `records/` in this repo. Decisions, brainstorms, and the session ledger live in the hub only; seam + Stop-hook wiring: `$HUB/governance/satellite-repos.md`. Ledger Repo column = `chronicle`. Focus lines and unlogged decisions are auto-swept after the session (CHI-148); do not fill them manually. Decisions Chi confirms live are still best logged in-flow to `$HUB/records/decisions.jsonl` via `python3 $HUB/scripts/aios_ledger.py append-decision` (`--stream chronicle`, `--session <id>`); never hand-edit the JSONL.

No `plans/` or `plans/workstate/` in this repo either. Live per-task workstate is hub-only, always: `$HUB/plans/workstate/YYYY-MM-DD-<ticket-or-slug>.md`, rides the feature branch, deleted at merge (`$HUB/governance/repo-contract.md` "One memory home per project"). Applies to every task, not just confidential ones.

## Dev knowledge (hub)

Deep dev-internal knowledge is hub-private (chronicle is public, so it does not go in the published `docs/` site). Under `$HUB/personal-projects/chronicle/`:

- `2026-08-15-chronicle-architecture.md`: architecture decisions (and why) + the Insights/Explore/Content engine.
- `2026-08-15-chronicle-key-files.md`: the server + client code map.
- `2026-08-15-chronicle-gotchas.md`: gotchas.
- `2026-08-15-chronicle-patterns.md`: patterns, TypeScript rules, npm/npx publish detail, verification habits.

Working plans and brainstorms also live under that hub folder (CHI-196).

## spec/ (in-repo, not published)

`spec/design-qa-rubric.md` (design-QA rubric, renamed from `design-rubric.md` CHI-244 to stop colliding with the hub's own readability-floor file of that name: 4 lenses, per-surface checklist, spacing/chart/popover policies, P0/P1/P2 severity) and `spec/surface-contract.md` (the frozen product shape / IA, formerly the body of `product-contract.md`; split out CHI-303) are read at release-walk time and by reviewers. `spec/product-contract.md` is now the terse module contract (what Chronicle is: surfaces, owned data, invariants) and points at both. They live in `spec/`, NOT `docs/` (VitePress `srcDir: 'docs'`, so `spec/` is not built into the public site) and NOT `.claude/` (harness-machinery only). Generate UI with the `frontend-design` / `dataviz` / `ui-ux-pro-max` skills; judge with `spec/design-qa-rubric.md`.

## Visibility

PUBLIC repo (`chizhangucb/chronicle`), published as the unscoped npm package `chronicle-cli`. Fail-closed: nothing confidential lands here (see pre-push scan).
