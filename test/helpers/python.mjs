// One rule for "this test needs python3", shared by every suite that drives
// litellm/*.py (issue #188).
//
// A machine without python3 skips: those tests are not what a contributor
// working on the React client should have to install an interpreter for. CI is
// the opposite: a skipped guard there is a guard that pins nothing, while the
// runbook goes on claiming the behaviour is defended. So CI sets
// CHRONICLE_REQUIRE_PYTHON=1 and the skip becomes a failure.
//
// It lives here rather than in one suite so the rule cannot hold in one file
// and quietly lapse in the other.
import assert from 'node:assert/strict';

/** True when a missing interpreter must fail rather than skip (CI sets this). */
export const pythonRequired = () => process.env.CHRONICLE_REQUIRE_PYTHON === '1';

/**
 * Decide what a spawnSync result that could not start python3 means.
 * Returns true when the caller should `return` (it has been skipped); false
 * when python3 ran and the test should continue. Fails outright under
 * CHRONICLE_REQUIRE_PYTHON=1.
 */
export function skipWithoutPython(t, result) {
  if (!result.error) return false;
  if (pythonRequired()) {
    assert.fail(`python3 is required here but did not run: ${result.error.message}`);
  }
  t.skip('no python3');
  return true;
}
