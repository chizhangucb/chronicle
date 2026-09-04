# model-routing product contract

Status: living · Owner: Chi · Location: hub `scripts/litellm/`

## Purpose
The one metered routing gateway (LiteLLM Lane C spine): every non-subscription model call goes through a single loopback endpoint that meters it and enforces the no-train gate. Which model may touch a task is a policy decision made elsewhere; this module enforces, it does not decide.

## Surfaces
- Loopback endpoint `127.0.0.1:4000` (OpenAI-compatible, master-key auth). The one address metered spokes point at.
- `openrouter/*` passthrough plus `glm-5.2` / `kimi-k3` short-name aliases (Lane C); `anthropic/*` direct path configured, not live (no key).
- `$LANE_C_SPEND_LOG`, default `<$CHRONICLE_DATA_DIR or ~/.chronicle>/litellm/spend.jsonl` — the Lane C raw spend capture (one JSONL row per completed request, metrics only).
- Installable launchd job (KeepAlive), template in `launchd/`; bounce with `launchctl kickstart -k`.
- `scripts/litellm/refresh_roster.py [--dry-run]` — refreshes only price + context columns.

## Owned data
- `scripts/litellm/config.yaml`: the authoritative deployment set (`store_model_in_db` off, no DB). Every deployment carries `provider.data_collection: deny`.
- The spend log above: Lane C's source-of-truth spend rows, local, never in git. Written only by `lane_c_spend_logger.py`, read by `server/laneC.ts`. No Postgres for the spine, ever.

## Consumers
- Hermes: reaches Lane C models via a `custom_providers:` entry pointed at the loopback; its default stays on Codex (Lane B).
- Varde dashboard aggregator `aggregator/sources/usage.ts` (`readLiteLlmSpend`): reads `spend.jsonl`.
- Chronicle: grows a parser over the same `spend.jsonl` (CHI-129).
- Any metered spoke: points at the loopback endpoint.

## Non-goals
- Does NOT decide routing/tier/trust; that policy lives outside this module.
- Does NOT meter Lane A (Claude, native) or Lane B (Codex, native); those bypass the spine.
- Does NOT hold subscription OAuth (ToS); does NOT run a DB, Postgres, or Redis.
- NOT safe on a network-exposed or multi-tenant host as configured (loopback + master key only).

## Invariants
CHI SIGN-OFF TO EDIT.
- `store_model_in_db` stays off; `config.yaml` is authoritative.
- Every OpenRouter deployment keeps `provider.data_collection: deny` (guarded by `scripts/tests/test_litellm_roster.py`).
- Master key never inlined; sourced from the environment or the gitignored env file `run.sh` reads (`$LITELLM_ENV_FILE`, default `litellm/.env`).
- Spend rows are metrics only; message content never lands in a row.
- A new model never enters routing until Chi adds it with a tier and trust level.

## Change triggers
New lane or upstream; a new metered spoke; spend-row schema change; the direct-to-Anthropic path going live; any move off loopback (cloud/multi-tenant). Update this file in the same pass.

## Pointers
- Policy brain: routing policy is decided outside this module; the roster comments in `config.yaml` are the enforcement view of it.
- Runbook: `scripts/litellm/README.md` (install, launch, spend capture, OpenRouter reconciliation).
- Job: `launchd/com.chronicle.litellm.plist.template`.
- Decisions: `records/decisions.jsonl` 2026-08-04 (Q5 routing), 2026-08-05 (P3a); CHI-100/103/105/111/129/130.

## Roadmap
- Now: Lane C live (glm-5.2, kimi-k3), no-train gate enforced in code.
- Next: direct-to-Anthropic key provisioned (precondition for the stricter per-tier gate); scheduled roster refresh.
- Later: stricter per-tier gate (pin sensitive tiers off hosted proxies onto direct/local); Hermes vision model. Trigger: Chi decides a tier must never touch a hosted proxy.
