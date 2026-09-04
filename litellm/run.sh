#!/bin/zsh
# LiteLLM spine launcher (AIOS Lane C). Loopback bind + master-key auth (keyless was
# rejected: no key and no DB makes LiteLLM 500 on Hermes's endpoint probes).
# Safe only on a single-tenant laptop; see config.yaml cloud caveat.
export PATH="$HOME/.local/bin:$PATH"
# Keys come from the canonical store (~/.secrets/shared.env).
# OPENROUTER_API_KEY (Lane C upstream) + LITELLM_MASTER_KEY (gates the loopback endpoint).
set -a
source "$HOME/.secrets/shared.env"
set +a
# Resolve this dir from the script path, so the spine lives wherever Chronicle does.
LITELLM_DIR="${0:A:h}"
# Put this dir on PYTHONPATH so the config's `lane_c_spend_logger.instance`
# success_callback (Lane C spend capture, CHI-130) resolves.
export PYTHONPATH="$LITELLM_DIR:$PYTHONPATH"
exec litellm --config "$LITELLM_DIR/config.yaml" --host 127.0.0.1 --port 4000
