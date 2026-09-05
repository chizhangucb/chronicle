#!/usr/bin/env python3
"""Refresh the volatile columns of the routing roster from OpenRouter's public catalog.

The routing roster table is hand-curated for judgment columns
(tier, trust, task-fit, lane) and auto-refreshed only for volatile facts (price,
context window). This script updates ONLY the volatile columns; it never touches the
judgment columns, and it never adds or removes rows. Reading a public price list is
not routing content through anyone.

Match key = the roster's Route column with the `openrouter/` prefix stripped, looked
up against the catalog's model id. Rows whose route is not `openrouter/...` (e.g. a
future direct-Anthropic route) are left untouched.

This script does not belong in litellm/ (it maintains an operator document; the
proxy never reads it). Moving it to scripts/ is issue #192.

The roster file is a personal document, not a repo one, so its location is
resolved rather than baked in (issue #186), in this order:

    --roster PATH
    $CHRONICLE_ROSTER_MD

With neither set the script runs and explains what to point it at; it
never guesses a machine-specific path.

Usage:
    python litellm/refresh_roster.py           # fetch live, update the file
    python litellm/refresh_roster.py --dry-run # print the diff, write nothing
    python litellm/refresh_roster.py --roster path/to/model-routing.md

Pure stdlib. Network only in main(); the parsing/rewriting functions are offline and
tested.
"""

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.request

CATALOG_URL = "https://openrouter.ai/api/v1/models"

_ROSTER_ENV = "CHRONICLE_ROSTER_MD"


def resolve_roster(cli_path=None, env=None):
    """Locate the roster markdown, or return None when nothing is configured.

    Order: --roster, then $CHRONICLE_ROSTER_MD. Nothing here is
    machine-specific; an unconfigured machine gets None, not a bad guess.
    """
    env = os.environ if env is None else env
    if cli_path:
        return pathlib.Path(cli_path).expanduser().resolve()
    direct = (env.get(_ROSTER_ENV) or "").strip()
    if direct:
        return pathlib.Path(direct).expanduser().resolve()
    return None


_NO_ROSTER = (
    "roster: no roster file configured. Pass --roster PATH, or set "
    f"{_ROSTER_ENV} to a model-routing.md."
)

# The roster header row, used to locate the table and the volatile columns.
_ROUTE_COL = "Route"
_PRICE_COL = "Price in/out (auto)"
_CONTEXT_COL = "Context (auto)"


def parse_catalog(catalog_json):
    """Map model id -> (prompt_per_1m, completion_per_1m, context_length).

    Catalog prices are per-token strings; we return per-1M-token floats.
    """
    out = {}
    for m in catalog_json.get("data", []):
        mid = m.get("id", "")
        pricing = m.get("pricing", {}) or {}
        try:
            prompt = float(pricing.get("prompt", 0)) * 1_000_000
            completion = float(pricing.get("completion", 0)) * 1_000_000
        except (TypeError, ValueError):
            continue
        out[mid] = (prompt, completion, m.get("context_length"))
    return out


def _fmt_price(prompt_1m, completion_1m):
    return f"${prompt_1m:.2f} / ${completion_1m:.2f}"


def _split_row(line):
    """Split a markdown table row into stripped cell values (drops leading/trailing |)."""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def update_roster_table(md_text, catalog):
    """Return md_text with only the roster's price + context cells refreshed.

    Judgment columns and non-openrouter rows are preserved byte-for-byte in value.
    Returns (new_text, changes) where changes is a list of (route, old, new) tuples.
    """
    lines = md_text.splitlines(keepends=False)
    # Locate the roster header row (the one containing the Route + auto columns).
    header_idx = None
    for i, line in enumerate(lines):
        if _ROUTE_COL in line and _PRICE_COL in line and line.lstrip().startswith("|"):
            header_idx = i
            break
    if header_idx is None:
        return md_text, []

    headers = _split_row(lines[header_idx])
    try:
        route_c = headers.index(_ROUTE_COL)
        price_c = headers.index(_PRICE_COL)
        ctx_c = headers.index(_CONTEXT_COL)
    except ValueError:
        return md_text, []

    changes = []
    # Data rows start after the header separator (header_idx + 1).
    for i in range(header_idx + 2, len(lines)):
        line = lines[i]
        if not line.lstrip().startswith("|"):
            break  # table ended
        cells = _split_row(line)
        if len(cells) <= max(route_c, price_c, ctx_c):
            continue
        route = cells[route_c]
        if not route.startswith("openrouter/"):
            continue
        model_id = route[len("openrouter/"):]
        if model_id not in catalog:
            continue
        prompt_1m, completion_1m, ctx = catalog[model_id]
        new_price = _fmt_price(prompt_1m, completion_1m)
        new_ctx = str(ctx) if ctx is not None else cells[ctx_c]
        if cells[price_c] != new_price or cells[ctx_c] != new_ctx:
            changes.append((route, (cells[price_c], cells[ctx_c]), (new_price, new_ctx)))
            cells[price_c] = new_price
            cells[ctx_c] = new_ctx
            # Rebuild the row preserving the leading "| " + " | " spacing style.
            lines[i] = "| " + " | ".join(cells) + " |"

    return "\n".join(lines) + ("\n" if md_text.endswith("\n") else ""), changes


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--roster", help="path to the roster markdown (overrides the env vars)")
    args = ap.parse_args(argv)

    roster = resolve_roster(args.roster)
    if roster is None:
        print(_NO_ROSTER, file=sys.stderr)
        return 2
    if not roster.is_file():
        print(f"roster: {roster} does not exist", file=sys.stderr)
        return 2

    with urllib.request.urlopen(CATALOG_URL, timeout=20) as r:
        catalog = parse_catalog(json.load(r))

    md = roster.read_text()
    new_md, changes = update_roster_table(md, catalog)
    if not changes:
        print("roster: no changes")
        return 0
    for route, old, new in changes:
        print(f"{route}: price {old[0]!r}->{new[0]!r}, ctx {old[1]!r}->{new[1]!r}")
    if args.dry_run:
        print("(dry-run, not written)")
        return 0
    roster.write_text(new_md)
    print(f"roster: updated {len(changes)} row(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
