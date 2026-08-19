// Characterization tests for the two new src/session/stats.ts helpers that
// feed the Session Overview chart grid (5d-2): toolMixSorted (tool_use
// counts by tool_name, desc, reshaped for Recharts' `data` prop) and
// cumulativeCostSeries (a per-turn running-cost series distributing each
// model's aggregate cost evenly across its assistant turns, in chronological
// order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMixSorted, cumulativeCostSeries, errorDrillIn } from '../src/session/stats.ts';

test('toolMixSorted: counts tool_use messages by tool_name, desc', () => {
  const messages = [
    { kind: 'tool_use', tool_name: 'Bash' }, { kind: 'tool_use', tool_name: 'Bash' },
    { kind: 'tool_use', tool_name: 'Read' }, { kind: 'user' },
  ];
  assert.deepEqual(toolMixSorted(messages), [{ name: 'Bash', count: 2 }, { name: 'Read', count: 1 }]);
});

test('cumulativeCostSeries: running total grows monotonically with each priced assistant turn', () => {
  const messages = [
    { kind: 'assistant', ts: '2026-01-01T00:00:00Z', model: 'claude-sonnet-5' },
    { kind: 'assistant', ts: '2026-01-01T00:05:00Z', model: 'claude-sonnet-5' },
  ];
  // usageByModel keyed by model name -> per-turn usage isn't tracked yet in
  // this fixture; a session with only aggregate usage still yields exactly
  // one point per priced model (a straight line to the total), not a crash.
  const series = cumulativeCostSeries(messages, { 'claude-sonnet-5': { input: 1000, output: 2000 } });
  assert.ok(series.length >= 1);
  assert.ok(series[series.length - 1].cumCost > 0);
  for (let i = 1; i < series.length; i++) assert.ok(series[i].cumCost >= series[i - 1].cumCost);
});

test('cumulativeCostSeries (CHI-228): a session straddling the Sonnet 5 intro cutover prices each day\'s turns at that day\'s rate, not one flat rate', () => {
  const messages = [
    { kind: 'assistant', ts: '2026-08-15T00:00:00Z', model: 'claude-sonnet-5' }, // intro window: $2/1M input
    { kind: 'assistant', ts: '2026-08-15T00:05:00Z', model: 'claude-sonnet-5' },
    { kind: 'assistant', ts: '2026-09-01T00:00:00Z', model: 'claude-sonnet-5' }, // post-cutover: $3/1M input
    { kind: 'assistant', ts: '2026-09-01T00:05:00Z', model: 'claude-sonnet-5' },
  ];
  // 4M total input tokens, evenly split by turn count -> 2M attributed to
  // each day. 2M @ $2/1M (2026-08-15) = $4, 2M @ $3/1M (2026-09-01) = $6.
  // Total $10 -- NOT $12 (all 4M at the flat post-cutover rate).
  const series = cumulativeCostSeries(messages, { 'claude-sonnet-5': { input: 4_000_000, output: 0 } });
  const final = series[series.length - 1].cumCost;
  assert.ok(Math.abs(final - 10) < 1e-9, `expected $10 total, got $${final}`);
});

// Task 6: the Errors KPI drill-in (OverviewMode → SessionView Playback filter)
// runs over exactly this helper's output — see errorDrillIn's header comment.
test('errorDrillIn: returns erroring tool_result rows plus their paired tool_use call, nothing else', () => {
  const messages = [
    { kind: 'user', text: 'do the thing' },
    { kind: 'assistant', text: 'ok' },
    { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'call-1' },
    { kind: 'tool_result', tool_use_id: 'call-1', text: 'Error: command failed' },
    { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'call-2' },
    { kind: 'tool_result', tool_use_id: 'call-2', text: 'file contents, all good' },
  ];
  const drilled = errorDrillIn(messages);
  assert.deepEqual(drilled, [messages[2], messages[3]]);
});

test('errorDrillIn: an error tool_result with no tool_use_id still surfaces on its own', () => {
  const messages = [
    { kind: 'tool_result', tool_use_id: null, text: 'fatal: something broke' },
    { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'call-1' },
    { kind: 'tool_result', tool_use_id: 'call-1', text: 'fine' },
  ];
  assert.deepEqual(errorDrillIn(messages), [messages[0]]);
});

test('errorDrillIn: no errors → empty result', () => {
  const messages = [
    { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'call-1' },
    { kind: 'tool_result', tool_use_id: 'call-1', text: 'ok' },
  ];
  assert.deepEqual(errorDrillIn(messages), []);
});
