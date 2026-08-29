// Regression pin for the hermetic-hub-env preload (CHI-393).
//
// The `test` script loads test/no-ambient-hub.mjs via `node --import`, which
// clears the ambient AIOS_HUB / CHRONICLE_HUB so the "absent hub" tests never
// inherit the real nisse hub a dev machine exports (which is why they failed
// locally but passed on CI). If that --import is ever dropped, this fails on any
// machine that exports AIOS_HUB, flagging the regression at its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ambient hub env is cleared for the suite (no-ambient-hub preload wired)', () => {
  assert.equal(
    process.env.AIOS_HUB, undefined,
    'AIOS_HUB leaked into the test env — is `--import ./test/no-ambient-hub.mjs` still in the package.json `test` script?',
  );
  assert.equal(process.env.CHRONICLE_HUB, undefined, 'CHRONICLE_HUB leaked into the test env — same preload check');
});
