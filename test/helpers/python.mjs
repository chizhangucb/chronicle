// One rule for "this test needs python3", read by the roster refresher's suite
// (issue #188). The refresher is the only Python left in the repo: the proxy
// spine that was the other reader is gone (issue #296).
//
// A machine without python3 skips. The refresher maintains the operator's own
// routing document, so it is not what a contributor working on the React
// client should have to install an interpreter for, and CI installs no Python
// of its own now that the spine it was pinned for is gone. The rule lives here
// rather than inside the suite so the next suite that shells out to python3
// inherits it instead of inventing its own answer.

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
