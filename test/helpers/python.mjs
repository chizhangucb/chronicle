// One rule for "this test needs python3" (issue #188).
//
// A machine without python3 skips: those tests are not what a contributor
// working on the React client should have to install an interpreter for. CI
// used to be the opposite, requiring an interpreter so a guard over the proxy
// spine's Python could not silently pass by skipping. That spine is gone
// (issue #296) and CI now installs Node and nothing else, so the skip is the
// whole rule and absence is never a failure.
//
// One caller is left: the roster refresher's suite, which drives an operator
// script rather than anything the app runs. The rule stays here rather than
// inside that suite for the same reason retired-vocabulary.mjs stays its own
// file on one caller -- it is the policy, not the pin, and a policy is easier
// to keep honest where the next suite that needs an interpreter will find it
// than as a private helper one file down.

/**
 * Decide what a spawnSync result that could not start python3 means.
 * Returns true when the caller should `return` (it has been skipped); false
 * when python3 ran and the test should continue.
 */
export function skipWithoutPython(t, result) {
  if (!result.error) return false;
  t.skip('no python3');
  return true;
}
