// Regression pin for the noise gate (server/noiseGate.ts).
//
// Bug: the gate used OR — a session was "minor" (hidden from the main lists in
// a collapsed bucket) if it was short on EITHER axis: agent-active < 5 min OR
// messages < 10. Real working sessions that happened to run under 5 min of
// agent-active time (fast tool loops) got buried, so they read as "not synced"
// / "missing" even though they imported fine. Fix: AND — minor only when short
// on BOTH axes (few messages AND brief), i.e. a true one-shot.
//
// noiseGate reads ~/.chronicle/config.json at call time for threshold
// overrides, so point CHRONICLE_DATA_DIR at an empty temp dir BEFORE importing
// to get the documented defaults (5 min active / 10 messages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-noise-'));
process.env.CHRONICLE_DATA_DIR = dir;
const { isMinorSession, DEFAULT_MINOR_ACTIVE_MS, DEFAULT_MINOR_MESSAGE_COUNT } = await import('../server/noiseGate.ts');

const MIN = 60 * 1000;

test('minor requires BOTH axes short (AND, not OR)', () => {
  // True one-shot: brief AND few messages -> minor.
  assert.equal(isMinorSession(20 * 1000, 3), true);

  // Regression cases that OR wrongly hid — few active minutes, many messages.
  // These are the real sessions the bug buried (fc190388 / c1025b8c).
  assert.equal(isMinorSession(94 * 1000, 21), false);  // ~1.6 min, 21 msgs
  assert.equal(isMinorSession(266 * 1000, 37), false); // ~4.4 min, 37 msgs

  // Long-but-quiet session (engaged a while, few messages) -> not minor either.
  assert.equal(isMinorSession(20 * MIN, 4), false);

  // Clearly substantive -> not minor.
  assert.equal(isMinorSession(30 * MIN, 200), false);
});

test('thresholds are strict less-than (== threshold is not minor)', () => {
  // active == threshold: not < threshold, so AND fails -> not minor.
  assert.equal(isMinorSession(DEFAULT_MINOR_ACTIVE_MS, 0), false);
  // count == threshold: not < threshold -> not minor.
  assert.equal(isMinorSession(0, DEFAULT_MINOR_MESSAGE_COUNT), false);
  // just under both -> minor.
  assert.equal(isMinorSession(DEFAULT_MINOR_ACTIVE_MS - 1, DEFAULT_MINOR_MESSAGE_COUNT - 1), true);
});

test('nullish inputs coerce to zero -> minor', () => {
  assert.equal(isMinorSession(undefined, undefined), true);
  assert.equal(isMinorSession(0, 0), true);
});
