> Moved here on 2026-09-03: Chronicle reads the Lane C spend log this proxy writes, so the proxy lives with its consumer. The routing-policy docs it used to cite were retired with the old repo shape; the policy comments in `config.yaml` are what remains. De-hubbed in issue #186: every path now resolves from this repo or a documented env var.

# LiteLLM spine (Lane C): runbook

The single metered routing gateway. This dir is the limb (enforcement config), not the source of truth.

- **Shape / interface:** `litellm/product-contract.md` (surfaces, owned data, invariants, roadmap).
- **Job:** `launchd/com.chronicle.litellm.plist.template`; bounce with `launchctl kickstart -k gui/$(id -u)/com.chronicle.litellm`.

Below is operational how-to only; anything about shape or policy lives above.

## Reproduce the install

`litellm` is an isolated uv tool (`~/.local/share/uv/tools/litellm`, litellm 1.95.0, Python 3.11).

```
uv tool install 'litellm[proxy]'
# Pin fastapi: litellm 1.95.0 imports fastapi.dependencies.utils.get_flat_dependant,
# which fastapi removed after 0.136.x. Its declared range (>=0.136.3) still resolves the
# newer, broken version, so pin the minimum explicitly.
uv pip install --python ~/.local/share/uv/tools/litellm/bin/python 'fastapi==0.136.3'
```

If `uv tool upgrade litellm` is ever run, re-apply the fastapi pin.

## Launch (loopback, master-key auth)

First, keys. Copy `litellm/.env.example` to `litellm/.env` (gitignored) and fill in
`OPENROUTER_API_KEY` + `LITELLM_MASTER_KEY`, or export them yourself; `$LITELLM_ENV_FILE`
moves the file elsewhere. Without them `run.sh` exits 78 naming what is missing, and
`install-jobs.mjs` declines to bootstrap the job rather than restart-loop it.

Normally you never launch it by hand: launchd `com.chronicle.litellm` keeps it up (template in `launchd/`, install with `node scripts/install-jobs.mjs`). `litellm/run.sh`
is what that job execs. It resolves its own dir, sources the env file, then binds
`127.0.0.1:4000`. Keyless was rejected: with no key and no DB, LiteLLM 500s on a
client's endpoint-probe requests.

```
litellm/run.sh
# or by hand. LITELLM_DIR must be ABSOLUTE: a relative one breaks the
# spend-logger callback, which resolves through PYTHONPATH.
LITELLM_DIR=/absolute/path/to/chronicle/litellm
set -a; source "${LITELLM_ENV_FILE:-$LITELLM_DIR/.env}"; set +a   # OPENROUTER_API_KEY + LITELLM_MASTER_KEY
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
litellm --config "$LITELLM_DIR/config.yaml" --host 127.0.0.1 --port 4000
```

Health: `curl http://127.0.0.1:4000/health/readiness` (unauth, fine). Models:
`curl -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4000/v1/models`.
Auth failure modes are ugly but closed (verified 2026-08-12): no key → 500 `internal_server_error`,
wrong key → 400 `No connected db.`; neither serves the catalog or reaches upstream.

### Testing a config change without touching the live spine

Never restart the live spine to try an edit. Start a second instance on another loopback port against the
candidate config, point a temp spend log at `/tmp` so Lane C's real capture stays clean, verify, then kill it.

```
LANE_C_SPEND_LOG=/tmp/litellm_scratch_spend.jsonl LITELLM_PORT=4111 litellm/run.sh
# or against a candidate config file:
LITELLM_DIR=/absolute/path/to/chronicle/litellm
set -a; source "${LITELLM_ENV_FILE:-$LITELLM_DIR/.env}"; set +a
export LANE_C_SPEND_LOG=/tmp/litellm_scratch_spend.jsonl
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
litellm --config <candidate>.yaml --host 127.0.0.1 --port 4111
```

## Lane C spend capture (CHI-130)

The spine runs with no DB (`GET /spend/logs` 500s by design). `lane_c_spend_logger.py` is the
`success_callback` that captures each completed request's cost before it evaporates (the CHI-111 hole).

- Wired in `config.yaml` as `litellm_settings.callbacks: [lane_c_spend_logger.instance]`; `run.sh` puts this
  dir on `PYTHONPATH`.
- Appends one JSONL row per completed request to `$LANE_C_SPEND_LOG`, defaulting to
  `<$CHRONICLE_DATA_DIR or ~/.chronicle>/litellm/spend.jsonl`, the same root `server/db.ts` uses,
  so Chronicle's Spend tab reads it with nothing configured. This file IS Lane C's raw capture.
  Local, never in git. **No Postgres for the spine, ever.**
- Row shape: `{startTime, model, prompt_tokens, completion_tokens, total_tokens, spend, provider, latency_ms}`.
  **Metrics only**, content never lands. `spend` = LiteLLM `response_cost` (OpenRouter's real charge); a
  zero/absent cost yields a token-only row (no `spend` key), never a guessed $0. `provider`/`latency_ms`
  emitted only when the payload carries them.
- Fail-soft: a logging error is swallowed and never breaks a request. Guarded by
  `test/litellm-runtime.test.mjs`.

### OpenRouter reconciliation (drift check, CHI-130 backstop b)

Lane C's JSONL is our capture; OpenRouter's own numbers are upstream truth. To check for drift, cross-check totals:

1. Sum the JSONL over a window:
   `python3 -c "import json,sys; print(round(sum(json.loads(l).get('spend',0) for l in open(sys.argv[1]) if l.strip()),6))" ~/.chronicle/litellm/spend.jsonl`
2. Pull OpenRouter's number for the same window (openrouter.ai/activity, or `GET /api/v1/credits`).
3. Expect near-equality. A gap means lost callback rows (spine restarted mid-request) or OpenRouter counting
   requests that never went through this spine. Run it when a Lane C number looks wrong; not yet automated.

## Roster refresh

`python litellm/refresh_roster.py [--dry-run]` updates only price + context from OpenRouter's public
catalog; never the judgment columns. The roster markdown is a hub document, not a repo one, so point the script at
one with `--roster PATH`, `$CHRONICLE_ROSTER_MD`, or `$CHRONICLE_HUB` (it resolves
`<hub>/governance/model-routing.md`). With none of those set it exits 2 and says so.
