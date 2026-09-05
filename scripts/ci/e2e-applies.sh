#!/usr/bin/env bash
#
# Does a change need the e2e gate? (issue #246)
#
# Reads changed paths, one per line, on stdin. Prints `true` if any of them
# could reach the running app, `false` if the change is confined to surfaces
# the e2e suite never loads.
#
# The exempt set is deliberately small and allow-listed by prefix, so the
# default for anything new is `true`: a path nobody thought about runs the
# gate rather than silently skipping it.
#
# - docs/       the published site, agent-only docs included
# - website/    getchronicle.dev, its own package and its own deploy
# - *.md        root-level markdown (README, CLAUDE, CONTEXT, AGENTS, ...)
#
# Note `spec/` is NOT exempt. Nothing there is loaded at runtime either, but
# those files are the contracts the walk judges against, and keeping them on
# the running side of the line costs one CI run and removes a judgement call.
#
# Lives here rather than inline in ci.yml so test/e2e-parallel-config.test.mjs
# can drive the real classification instead of pattern-matching YAML.
set -euo pipefail

applies=false

# `|| [ -n "$file" ]` so a final line with no trailing newline still counts:
# `read` sets the variable but returns non-zero on one, which would otherwise
# drop the last changed path on the floor.
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  # Order carries the logic: the two exempt trees first, then everything left
  # in a subdirectory runs the gate (so `spec/surface-contract.md` does), and
  # only what remains at the root can be exempt markdown.
  case "$file" in
    docs/* | website/*) ;;
    */*) applies=true ;;
    *.md) ;;
    *) applies=true ;;
  esac
done

echo "$applies"
