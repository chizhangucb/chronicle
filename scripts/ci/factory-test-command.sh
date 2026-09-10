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
# This file has to be on main before the caller names it. The gate's other side
# is a checkout of the base branch with only the PR's changed TEST files laid
# over it, so until this has merged it is absent there, and the base side fails
# for want of this file rather than for want of the test.
#
# What naming any command of our own costs: the gate can only tell "died before
# any test reported" from "ran and failed" for its own default, `node --test`,
# because that is the only output it will parse. Under this command every file
# counts as having run, so a unit file that dies on import is blamed as a
# failure rather than passed over. That is the trade for a real red-green proof
# on browser specs, which is the half we cannot get any other way.
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
  # A leading ./ is stripped first: the gate hands over repo-relative paths as
  # git prints them, but a hand run naturally writes ./test/e2e/x.spec.ts, and
  # that spelling falling through to `node --test` is the very bug this file
  # exists to prevent.
  case "${1#./}" in
    test/e2e/*.spec.ts) npm run test:e2e -- "$1" ;;
    *)                  node --test "$1" ;;
  esac
}

# Given nothing to run, say so and fail. The gate always passes exactly one
# file, so reaching here empty means something went wrong upstream, and a
# command that answers that with a silent success is a green check over
# nothing run at all.
if [ "$#" -eq 0 ]; then
  echo "factory-test-command: no test files given" >&2
  exit 2
fi

status=0
for file in "$@"; do
  echo "== $file"
  run_test_file "$file" || status=1
done
exit "$status"
