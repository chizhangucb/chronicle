#!/usr/bin/env bash
#
# Which command runs one changed test file? (issue #335)
#
# The factory's merge gate proves that the tests a factory PR touched fail on
# main and pass on the branch. To do that it runs each changed test file with
# one test command, handed to it by our caller. We have two kinds of test, so
# one command cannot serve both: handed to `node --test`, a browser spec dies
# on import before a single test reports, and the gate learns nothing about it.
#
# This is that command. Given changed test file paths, it runs each with the
# command its kind needs and exits non-zero if any of them failed.
#
# Chromium is the caller's `install_command`, once per checkout. The client
# build is not: `ensureClientBuilt()` in test/e2e/harness.ts builds it from
# inside globalSetup, so it is paid only when a browser spec actually runs.
#
# Lives here rather than inline in the caller so test/factory-test-command.test.mjs
# can drive the real routing instead of pattern-matching YAML, the same reason
# e2e-applies.sh sits beside it. That script answers a different question, for
# the whole changeset rather than one path: whether a change needs the e2e gate
# at all. It says `true` for a pure unit-test change, so it cannot tell a
# browser spec from a node test and is not the rule to share here.
#
# No `-e`: a failing file must not stop the files after it. The gate judges
# each changed test file on its own, so each one needs its own answer.
set -uo pipefail

# playwright.config.ts is the source of truth for what a browser spec is
# (`testDir: './test/e2e'`, `testMatch: '**/*.spec.ts'`), and
# test/factory-test-command.test.mjs pins this pattern against it, so the two
# cannot drift. A spec must go through Playwright and nothing else: its run
# directory is created by globalSetup and inherited by the workers, and
# currentRunDir() throws rather than guess when something else invokes it.
run_test_file() {
  case "$1" in
    test/e2e/*.spec.ts) npm run test:e2e -- "$1" ;;
    *)                  node --test "$1" ;;
  esac
}

status=0
for file in "$@"; do
  echo "== $file"
  run_test_file "$file" || status=1
done
exit "$status"
