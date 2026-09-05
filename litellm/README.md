# The LiteLLM spine: what it is, how to run it

Chronicle's Spend tab charts what your model calls cost. For calls made through a
Claude Code or Codex subscription there is nothing to meter. For calls billed per
token there is, and nothing writes that number down unless something sits in the
path and records it.

That something is this directory: a local [LiteLLM](https://docs.litellm.ai) proxy on
`127.0.0.1:4000`, OpenAI-compatible, master-key authed. Point a pay-per-token client
at it instead of at the provider, and every completed request leaves a row in a spend
log that Chronicle reads. Nothing here decides *which* model should handle a task;
it meters and enforces the calls it is handed.

Running it is optional. Chronicle imports sessions and serves Insights with the proxy
switched off; the Spend tab is simply empty of metered rows.

## Words used below

- **Spine** - this proxy. One address, so metering happens in one place rather than in
  every client.
- **Lane C** - calls billed per token, which is what the spine meters. Claude Code and
  Codex subscription calls are not Lane C and never touch the proxy.
- **Roster** - the hand-curated table of which models are allowed, at what tier and
  trust level. It is a personal document that lives outside this repo; `refresh_roster.py`
  updates it, and the proxy never reads it.

## Contract

### Surfaces

- `127.0.0.1:4000` - OpenAI-compatible endpoint, master-key auth. The one address a
  metered client points at.
- Models: `openrouter/*` passthrough plus the `glm-5.2` / `kimi-k3` short-name aliases.
  A direct `anthropic/*` path is configured but not live (no key).
- `$LANE_C_SPEND_LOG`, default `<$CHRONICLE_DATA_DIR or ~/.chronicle>/litellm/spend.jsonl` -
  one JSONL row per completed request, metrics only.
- A launchd job, template in `launchd/com.chronicle.litellm.plist.template`, installed by
  `scripts/install-jobs.mjs`.
- `litellm/refresh_roster.py [--dry-run]` - refreshes only the roster's price and context
  columns.

### Owned data

- `litellm/config.yaml` is the authoritative deployment set. `store_model_in_db` is off
  and there is no database; the file is the whole configuration.
- The spend log is the raw capture. Local, never in git, written only by
  `litellm/lane_c_spend_logger.py`. Chronicle does not read it: the app shows one
  spend figure, estimated from your sessions (issue #217).

### Non-goals

- Does not decide routing, tier or trust. It enforces what `config.yaml` already says.
- Does not meter subscription calls; those bypass the proxy entirely.
- Does not hold subscription OAuth credentials, and does not run Postgres, Redis, or any
  database. Not now, not later.
- Is not safe on a network-exposed or multi-tenant host as configured. Loopback and a
  master key are the whole security model.

### Invariants

- `store_model_in_db` stays off; `config.yaml` stays authoritative.
- Every OpenRouter deployment keeps `provider.data_collection: deny`, so no prompt is
  handed to an upstream that trains on it.
- The master key is never inlined. It is sourced from the environment, or from the
  gitignored env file `run.sh` reads.
- Spend rows are metrics only. Message content never lands in a row.
- A model does not enter routing until it is added deliberately, with a tier and a trust
  level.

Change any of those and the change belongs in this file in the same pass, along with a
new lane or upstream, a spend-row schema change, the direct-to-Anthropic path going live,
or any move off loopback.

## Install

`litellm` is an isolated uv tool (`~/.local/share/uv/tools/litellm`, litellm 1.95.0,
Python 3.11).

```
uv tool install 'litellm[proxy]'
# Pin fastapi: litellm 1.95.0 imports fastapi.dependencies.utils.get_flat_dependant,
# which fastapi removed after 0.136.x. Its declared range (>=0.136.3) still resolves the
# newer, broken version, so pin the minimum explicitly.
uv pip install --python ~/.local/share/uv/tools/litellm/bin/python 'fastapi==0.136.3'
```

Re-apply the fastapi pin after any `uv tool upgrade litellm`.

## Launch

First, keys. Copy `litellm/.env.example` to `litellm/.env` (gitignored) and fill in
`OPENROUTER_API_KEY` and `LITELLM_MASTER_KEY`, or export them yourself; `$LITELLM_ENV_FILE`
moves the file elsewhere. Without them `run.sh` exits 78 naming what is missing, and
`scripts/install-jobs.mjs` declines to bootstrap the job rather than leave it restart-looping.

Normally you never launch by hand: the launchd job `com.chronicle.litellm` keeps it up
(`node scripts/install-jobs.mjs` installs it). `litellm/run.sh` is what that job execs. It
resolves its own directory, sources the env file, then binds `127.0.0.1:4000`. Keyless was
rejected: with no key and no database, LiteLLM 500s on a client's endpoint-probe requests.

```
litellm/run.sh
# or by hand. LITELLM_DIR must be ABSOLUTE: a relative one breaks the
# spend-logger callback, which resolves through PYTHONPATH.
LITELLM_DIR=/absolute/path/to/chronicle/litellm
set -a; source "${LITELLM_ENV_FILE:-$LITELLM_DIR/.env}"; set +a   # OPENROUTER_API_KEY + LITELLM_MASTER_KEY
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
litellm --config "$LITELLM_DIR/config.yaml" --host 127.0.0.1 --port 4000
```

Restart it with `launchctl kickstart -k gui/$(id -u)/com.chronicle.litellm`.

## Verify

```
curl http://127.0.0.1:4000/health/readiness                      # unauth, fine
curl -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4000/v1/models
```

Auth failure modes are ugly but closed (verified 2026-08-12): no key gives a 500
`internal_server_error`, a wrong key gives a 400 `No connected db.` Neither one serves the
catalog or reaches upstream.

### Trying a config change without touching the running proxy

Never restart the live proxy to try an edit. Start a second instance on another loopback
port against the candidate config, point its spend log at `/tmp` so the real capture stays
clean, verify, then kill it.

```
LANE_C_SPEND_LOG=/tmp/litellm_scratch_spend.jsonl LITELLM_PORT=4111 litellm/run.sh
# or against a candidate config file:
LITELLM_DIR=/absolute/path/to/chronicle/litellm
set -a; source "${LITELLM_ENV_FILE:-$LITELLM_DIR/.env}"; set +a
export LANE_C_SPEND_LOG=/tmp/litellm_scratch_spend.jsonl
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
litellm --config <candidate>.yaml --host 127.0.0.1 --port 4111
```

## How spend capture works

The proxy runs with no database, so `GET /spend/logs` 500s by design and the cost of a
completed request would otherwise evaporate. `litellm/lane_c_spend_logger.py` is the
`success_callback` that catches it first.

- Wired in `config.yaml` as `litellm_settings.callbacks: [lane_c_spend_logger.instance]`.
  `run.sh` puts this directory on `PYTHONPATH` so that import resolves.
- It appends one JSONL row per completed request to `$LANE_C_SPEND_LOG`, defaulting under
  the same data root `server/db.ts` uses, so Chronicle's Spend tab reads it with nothing
  configured.
- Row shape: `{startTime, model, prompt_tokens, completion_tokens, total_tokens, spend,
  provider, latency_ms}`. Metrics only. `spend` is LiteLLM's `response_cost`, the real
  upstream charge; a zero or absent cost yields a token-only row with no `spend` key, never
  a guessed $0. `provider` and `latency_ms` are emitted only when the payload carries them.
- Fail-soft: a logging error is swallowed and never breaks the request it was recording.

Two node suites guard this, both on every PR. `test/litellm-runtime.test.mjs` pins the
parts that would silently rot: where the log defaults to, that a written row is one the
Spend tab reads back, and that no path in here goes machine-specific.
`test/litellm-guards.test.mjs` pins the promises above: fail-soft, metrics only, and no
guessed `$0`. Both shell out to `python3` rather than adding a second test runner; CI sets
`CHRONICLE_REQUIRE_PYTHON=1` so a missing interpreter fails instead of skipping.

## Checking the numbers against OpenRouter

The JSONL is our capture; OpenRouter's own accounting is upstream truth. To check for
drift, compare totals over a window:

1. Sum the JSONL:
   `python3 -c "import json,sys; print(round(sum(json.loads(l).get('spend',0) for l in open(sys.argv[1]) if l.strip()),6))" ~/.chronicle/litellm/spend.jsonl`
2. Pull OpenRouter's number for the same window (openrouter.ai/activity, or
   `GET /api/v1/credits`).
3. Expect near-equality. A gap means either lost callback rows (the proxy restarted
   mid-request) or OpenRouter counting requests that never went through here.

Run it when a spend number looks wrong. It is not automated.

## Roster refresh

`python litellm/refresh_roster.py [--dry-run]` updates only the price and context columns
of the roster from OpenRouter's public catalog, never the judgment columns
(`test/litellm-guards.test.mjs` pins that, including that no row is added or dropped).
The roster is a personal document rather than a repo one, so point the script at it with
`--roster PATH` or `$CHRONICLE_ROSTER_MD`. With neither set it exits 2 and says so.

## Where things live

- Routing policy is decided outside this directory. The comments in `config.yaml` are the
  enforcement view of it.
- The launchd template is `launchd/com.chronicle.litellm.plist.template`.
