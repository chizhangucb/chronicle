// Characterization tests for the two new src/session/stats.ts helpers that
// feed the Session Overview chart grid (5d-2): toolMixSorted (a Recharts-
// shaped wrapper around the existing topDist) and cumulativeCostSeries (a
// per-turn running-cost series distributing each model's aggregate cost
// evenly across its assistant turns, in chronological order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMixSorted, cumulativeCostSeries } from '../src/session/stats.ts';

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
