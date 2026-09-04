"""Lane C spend logger: the LiteLLM spine's success_callback (CHI-130).

Policy brain: governance/model-routing.md. Architecture: the 2026-08-08
monitoring-dashboard-direction brainstorm, Q4. This dir is the limb.

The spine is a gateway; it leaves NO session files. A completed request's
cost (OpenRouter's real charge, routed provider) exists only in-flight and
otherwise evaporates -- that was the CHI-111 hole. This callback captures it
to a local JSONL, one row per completed request. That file IS Lane C's raw
capture: the dashboard aggregator reads it now (aggregator/sources/usage.ts),
Chronicle grows a parser for the same file later (CHI-129). No Postgres for
the spine, ever.

Wired in config.yaml as `litellm_settings.callbacks: [lane_c_spend_logger.instance]`
(run.sh puts this dir on PYTHONPATH).

Confidentiality: metrics only. The row carries model + token counts + the
authoritative dollar cost + (CHI-105) the routed upstream host label and
measured latency. It NEVER carries message content, even though the success
payload does. Dollars are authoritative-from-source (response_cost); a
zero/absent cost yields a token-only row, never a guessed $0. The upstream
host is likewise read-only-if-present; an absent host yields a host-less row,
never a guessed provider.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import sys

# The CustomLogger base only exists inside the litellm runtime (the uv tool
# venv). Import-guard it so the pure shapers (build_row / write_row) stay
# testable under the hub's plain-python3 pytest.
try:  # pragma: no cover - trivial import shim
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # noqa: BLE001
    CustomLogger = object  # type: ignore[assignment,misc]

DEFAULT_PATH = os.path.expanduser("~/.aios/litellm/spend.jsonl")


def _iso(start_time) -> str | None:
    """Epoch-seconds float (StandardLoggingPayload.startTime) -> ISO8601 UTC
    string the dashboard's `new Date(row.startTime)` can parse. Passes an
    existing string through; returns None if unusable."""
    if start_time is None:
        return None
    if isinstance(start_time, str):
        return start_time or None
    try:
        ts = float(start_time)
    except (TypeError, ValueError):
        return None
    dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    # Drop microseconds, use a Z suffix to match the existing lane fixtures.
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extract_provider(slo: dict) -> str | None:
    """CHI-105: the upstream no-train host OpenRouter actually routed to
    (Fireworks / Baseten / Together / DeepInfra ...), which the spine's
    provider.order steers. OpenRouter surfaces this as a top-level `provider`
    string on the completion response body; LiteLLM's StandardLoggingPayload
    carries the response under a few version-dependent keys, so walk the known
    candidates and return the first non-empty string. Reads ONLY the provider
    label, never any message/content field. Returns None when absent (the row
    stays host-less and the dashboard hides the badge, never guesses a host).
    """
    # 1. A flattened top-level provider, if a future LiteLLM ever surfaces one.
    direct = slo.get("provider")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    # 2. The response body OpenRouter returns puts `provider` at the top level.
    resp = slo.get("response")
    if isinstance(resp, dict):
        p = resp.get("provider")
        if isinstance(p, str) and p.strip():
            return p.strip()
    # 3. LiteLLM stashes passthrough provider fields under hidden_params.
    hidden = slo.get("hidden_params")
    if isinstance(hidden, dict):
        for key in ("upstream_provider", "provider"):
            p = hidden.get(key)
            if isinstance(p, str) and p.strip():
                return p.strip()
    return None


def _latency_ms(slo: dict) -> int | None:
    """CHI-105: end-to-end request latency in ms, from the payload's epoch
    startTime/endTime floats. None when either bound is missing or the span is
    not positive (never emit a bogus 0 or negative latency)."""
    start, end = slo.get("startTime"), slo.get("endTime")
    try:
        span = float(end) - float(start)
    except (TypeError, ValueError):
        return None
    if span <= 0:
        return None
    return int(round(span * 1000))


def build_row(slo: dict | None) -> dict | None:
    """Shape a StandardLoggingPayload dict into one Lane C JSONL row, or None.

    Row keys (the dashboard's LiteLlmSpendRow contract): startTime, model,
    prompt_tokens, completion_tokens, total_tokens, `spend` ONLY when a real
    positive cost was captured, and (CHI-105) `provider` + `latency_ms` ONLY
    when the upstream host / a positive latency span were captured. No content
    field is ever read into a row.
    """
    if not slo:
        return None
    model = slo.get("model") or ""
    if not model:
        return None

    start = _iso(slo.get("startTime"))
    row: dict = {
        "startTime": start,
        "model": model,
        "prompt_tokens": int(slo.get("prompt_tokens") or 0),
        "completion_tokens": int(slo.get("completion_tokens") or 0),
        "total_tokens": int(slo.get("total_tokens") or 0),
    }

    # Authoritative dollars only. A None/0 cost is an honest token-only row,
    # never a guessed $0 (the dashboard surfaces the gap; it never invents $).
    cost = slo.get("response_cost")
    try:
        cost = float(cost) if cost is not None else 0.0
    except (TypeError, ValueError):
        cost = 0.0
    if cost > 0:
        row["spend"] = cost

    # CHI-105: no-train host steering visibility. Emit the routed upstream host
    # and measured latency when the payload carries them; omit both otherwise
    # (the dashboard hides the host badge rather than inventing one).
    provider = _extract_provider(slo)
    if provider:
        row["provider"] = provider
    latency = _latency_ms(slo)
    if latency is not None:
        row["latency_ms"] = latency

    return row


def write_row(row: dict, path: str) -> bool:
    """Append one JSON line to `path`, creating the parent dir. Fail-soft:
    returns False on any error and never raises into the request path."""
    try:
        parent = os.path.dirname(path)
        if parent:
            pathlib.Path(parent).mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return True
    except Exception as err:  # noqa: BLE001 - logging must never break a request
        print(f"[lane-c-spend] write failed: {err}", file=sys.stderr)
        return False


class LaneCSpendLogger(CustomLogger):  # type: ignore[misc,valid-type]
    """LiteLLM success_callback. Appends one Lane C row per completed request.

    Path resolves from the constructor arg, else $LANE_C_SPEND_LOG, else
    ~/.aios/litellm/spend.jsonl.
    """

    def __init__(self, path: str | None = None):
        # `object.__init__` takes no args; CustomLogger may. Guard both.
        try:
            super().__init__()  # type: ignore[misc]
        except Exception:  # noqa: BLE001
            pass
        self.path = path or os.environ.get("LANE_C_SPEND_LOG") or DEFAULT_PATH

    def _capture(self, kwargs) -> None:
        slo = (kwargs or {}).get("standard_logging_object")
        row = build_row(slo)
        if row is not None:
            write_row(row, self.path)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs)


# Module-level singleton referenced from config.yaml as
# `lane_c_spend_logger.instance`.
instance = LaneCSpendLogger()
