# Chronicle

Local-first AI coding session manager: it imports logs from Claude Code, Codex, Cursor and OpenCode, maps every message to a Git snapshot, redacts secrets, and serves a tabbed Insights home. Ships as a local web app via `npx chronicle-cli`. No cloud, no telemetry, no LLM calls; everything heavy is heuristic and local. Public repo, Apache-2.0, published as the npm package `chronicle-cli`.

## Words

`CONTEXT.md` is the glossary. Use its terms; it also names the words to avoid. `spec/surface-contract.md` is the frozen product shape: routes, surfaces, enumerables.

## The map

- `src/` the React client. `server/` the Express API and the import, snapshot and insights engines. `shared/` the types both sides use.
- `spec/` the contracts the release walk judges against, read by reviewers, not published.
- `docs/` the published site (guide, reference, architecture, contributing). `docs/agents/` and `docs/adr/` are agent-only and excluded from the build.
- `test/` node --test suites. `scripts/` deterministic mechanics. `bin/` the `npx chronicle-cli` entrypoint.
- `website/` the getchronicle.dev marketing site, its own package and deploy.
- `package.json` scripts are the source of truth for every command; `.github/workflows/` for every gate.

## Tracker

Work is tracked as GitHub issues on this repo (`chizhangucb/chronicle`), via `gh`. See `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Working with Chi

- Lead with what needs action; answer the question asked.
- Write concise, bullets, casual, no em dashes, no hype. Files included.
- Plan first for anything non-trivial; the plan gets a yes before the build.
- Branch and PR for anything non-trivial; keep direct-to-main for agreed one-offs. Return to freshly pulled `main` before the next branch.
- Green typecheck, tests and build before a PR goes up. `docs/contributing.md` has the loop.
- Act on anything reversible without asking. Stop to send anything in Chi's voice, or when a guard blocks.
