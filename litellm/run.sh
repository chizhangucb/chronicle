#!/bin/zsh
# LiteLLM spine launcher (Lane C). Loopback bind + master-key auth (keyless was
# rejected: no key and no DB makes LiteLLM 500 on endpoint probes).
# Safe only on a single-tenant laptop; see config.yaml cloud caveat.
#
# Everything resolves from this repo or a documented env var, so a fresh clone
# starts the proxy with no machine-specific setup (issue #186):
#
#   LITELLM_ENV_FILE   env file to source (default: litellm/.env in this repo,
#                      sourced only if it exists; see litellm/.env.example)
#   OPENROUTER_API_KEY upstream key (required)
#   LITELLM_MASTER_KEY gates the loopback endpoint (required)
#   ANTHROPIC_API_KEY  optional, only for the direct anthropic/* route
#   LANE_C_SPEND_LOG   spend log path (default: <data dir>/litellm/spend.jsonl)
#   CHRONICLE_DATA_DIR Chronicle's data dir (default: ~/.chronicle)
#   LITELLM_PORT       loopback port (default: 4000) -- for trying a candidate
#                      config on a second instance without touching the live one
set -e
export PATH="$HOME/.local/bin:$PATH"

# Resolve this dir from the script path, so the spine lives wherever Chronicle does.
LITELLM_DIR="${0:A:h}"

# Secrets come from the environment, or from an env file the user creates.
# Never a hardcoded path outside the repo.
ENV_FILE="${LITELLM_ENV_FILE:-$LITELLM_DIR/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# A whitespace-only value is not a key. Strip every space before testing (not
# just the ends: we only care whether anything is left), so this agrees with
# scripts/install-jobs.mjs rather than starting with an unusable key and failing
# later, upstream, where the cause is not obvious.
# `${(P)key}` is zsh for "the value of the variable NAMED by $key".
missing=()
for key in OPENROUTER_API_KEY LITELLM_MASTER_KEY; do
  [[ -n "${(P)key//[[:space:]]/}" ]] || missing+=("$key")
done
if (( ${#missing[@]} )); then
  print -u2 "litellm/run.sh: missing ${missing[*]}."
  print -u2 "Set them in the environment, or copy litellm/.env.example to $ENV_FILE and fill it in."
  exit 78  # EX_CONFIG
fi

# Optional route, kept configured but not live: give the yaml's
# os.environ/ANTHROPIC_API_KEY something to resolve so a missing key can never
# block startup.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

# Put this dir on PYTHONPATH so the config's `lane_c_spend_logger.instance`
# success_callback (Lane C spend capture) resolves.
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
# The host is NOT a knob. config.yaml's gate is "loopback bind + master key",
# and off-laptop the key alone is not enough (its CLOUD CAVEAT); an env var that
# let a user bind 0.0.0.0 would expose an OpenRouter-key-bearing endpoint to the
# network while the config still claimed loopback-only.
exec litellm --config "$LITELLM_DIR/config.yaml" \
  --host 127.0.0.1 --port "${LITELLM_PORT:-4000}"
