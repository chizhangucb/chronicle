// Characterization tests for server/durations.js (pure module, no DB import).
// Pin the exact current arithmetic so a mutation (wrong cap, dropped
// human-prompt exclusion, etc.) fails the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNTHETIC_USER_RE, isHumanPrompt, agentActiveMs, engagedMs } from '../server/durations.js';

const MIN = 60 * 1000;
const T0 = '2026-01-01T00:00:00.000Z';
function plus(ms) {
  return new Date(new Date(T0).getTime() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// isHumanPrompt / SYNTHETIC_USER_RE
// ---------------------------------------------------------------------------

test('isHumanPrompt: true for a genuine typed user message', () => {
  assert.equal(isHumanPrompt({ kind: 'user', text: 'do X' }), true);
});

test('isHumanPrompt: false for each synthetic user-role prefix', () => {
  const prefixes = [
    '<task-notification>build finished</task-notification>',
    '<launch-selected-element>button</launch-selected-element>',
    '<system-reminder>context</system-reminder>',
    '<command-name>/rename</command-name>',
    '<command-message>running</command-message>',
    '<local-command-stdout>ok</local-command-stdout>',
    '[Request interrupted by user]',
  ];
  for (const text of prefixes) {
    assert.equal(isHumanPrompt({ kind: 'user', text }), false, `expected false for: ${text}`);
    assert.equal(SYNTHETIC_USER_RE.test(text), true, `expected regex match for: ${text}`);
  }
});

test('isHumanPrompt: false for non-user kinds even with plain text', () => {
  assert.equal(isHumanPrompt({ kind: 'assistant', text: 'do X' }), false);
  assert.equal(isHumanPrompt({ kind: 'tool_use', text: 'do X' }), false);
  assert.equal(isHumanPrompt({ kind: 'thinking', text: 'do X' }), false);
  assert.equal(isHumanPrompt({ kind: 'tool_result', text: 'do X' }), false);
});

// ---------------------------------------------------------------------------
// agentActiveMs — rule 1: gap INTO a genuine human prompt is excluded
// ---------------------------------------------------------------------------

test('agentActiveMs: a gap leading into a human prompt is excluded entirely', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'user', text: 'do the next thing', ts: plus(5 * MIN) },
  ];
  assert.equal(agentActiveMs(events), 0);
});

test('agentActiveMs: a gap into a SYNTHETIC user message is NOT excluded (counted, capped)', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'user', text: '<task-notification>build finished</task-notification>', ts: plus(25 * MIN) },
  ];
  // Not a genuine human prompt, not a matched tool_result -> generic rule, capped at 10 min.
  assert.equal(agentActiveMs(events), 10 * MIN);
});

// ---------------------------------------------------------------------------
// agentActiveMs — rule 2: gap ending in a MATCHED tool_result counts in FULL
// ---------------------------------------------------------------------------

test('agentActiveMs: a gap ending in a matched tool_result counts in full, no cap (30 min)', () => {
  const events = [
    { kind: 'tool_use', ts: plus(0), tool_use_id: 'abc' },
    { kind: 'tool_result', ts: plus(30 * MIN), tool_use_id: 'abc' },
  ];
  assert.equal(agentActiveMs(events), 30 * MIN);
});

test('agentActiveMs: a tool_result with an UNMATCHED tool_use_id gets the 10-min cap, not full', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'tool_result', ts: plus(20 * MIN), tool_use_id: 'zzz-never-seen' },
  ];
  assert.equal(agentActiveMs(events), 10 * MIN);
});

// ---------------------------------------------------------------------------
// agentActiveMs — rule 3: everything else capped at 10 min
// ---------------------------------------------------------------------------

test('agentActiveMs: a plain assistant-to-assistant gap is capped at 10 min (25-min gap -> 10 min)', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'assistant', ts: plus(25 * MIN) },
  ];
  assert.equal(agentActiveMs(events), 10 * MIN);
});

test('agentActiveMs: rows are sorted by ts internally regardless of input order', () => {
  const events = [
    { kind: 'assistant', ts: plus(10 * MIN) },
    { kind: 'assistant', ts: plus(0) },
  ];
  // If the events were summed in input order (not sorted), the first gap
  // would be negative (10min -> 0min) and excluded, yielding 0. Sorted, the
  // single 10-min gap is counted (capped at 10 min, which equals the raw gap
  // here so the cap itself isn't exercised by this case — the sort is).
  assert.equal(agentActiveMs(events), 10 * MIN);
});

test('agentActiveMs: rows with an unparseable ts are dropped from the scan', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'assistant', ts: 'not-a-real-timestamp' },
    { kind: 'assistant', ts: plus(3 * MIN) },
  ];
  // The garbage-ts row is dropped entirely, leaving a single 3-min gap
  // between the two valid rows (well under the cap).
  assert.equal(agentActiveMs(events), 3 * MIN);
});

test('agentActiveMs: combined scenario exercising all three rules in one timeline', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    // rule 2: full 30-min tool run, no cap
    { kind: 'tool_use', ts: plus(1 * MIN), tool_use_id: 't1' },
    { kind: 'tool_result', ts: plus(31 * MIN), tool_use_id: 't1' },
    // rule 3: 25-min generic gap -> capped at 10 min
    { kind: 'assistant', ts: plus(56 * MIN) },
    // rule 1: gap into a genuine human prompt -> excluded
    { kind: 'user', text: 'looks good, next step', ts: plus(61 * MIN) },
  ];
  // gaps: (1-0)=1min generic capped->1min; (31-1)=30min matched tool_result->30min full;
  // (56-31)=25min generic capped->10min; (61-56)=5min into human prompt->excluded.
  const expected = 1 * MIN + 30 * MIN + 10 * MIN;
  assert.equal(agentActiveMs(events), expected);
});

// ---------------------------------------------------------------------------
// engagedMs — sum of ALL gaps, each capped at 90 min, no human distinction
// ---------------------------------------------------------------------------

test('engagedMs: sums all gaps uncapped when under the 90-min cap', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'tool_use', ts: plus(10 * MIN) },
    { kind: 'tool_result', ts: plus(30 * MIN) },
  ];
  assert.equal(engagedMs(events), 10 * MIN + 20 * MIN);
});

test('engagedMs: a gap over 90 min is clamped to exactly 90 min', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'assistant', ts: plus(120 * MIN) },
  ];
  assert.equal(engagedMs(events), 90 * MIN);
});

test('engagedMs: unlike agentActiveMs, a gap into a genuine human prompt is still counted', () => {
  const events = [
    { kind: 'assistant', ts: plus(0) },
    { kind: 'user', text: 'do the next thing', ts: plus(30 * MIN) },
  ];
  assert.equal(engagedMs(events), 30 * MIN);
});
