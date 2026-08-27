// CHI-324 2f: the Claude plan-windows payload parser (pure — no outbound). The
// live fetch + opt-in gate are exercised by the route; here we pin the shape
// parsing so a contract change in Anthropic's usage payload fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload } from '../server/planWindows.ts';

test('parsePayload reads five_hour / seven_day / seven_day_opus windows', () => {
  const r = parsePayload({
    five_hour: { utilization: 41, resets_at: '2026-08-27T15:00:00Z' },
    seven_day: { utilization: 63, resets_at: '2026-08-29T00:00:00Z' },
    seven_day_opus: { utilization: 22, resets_at: '2026-08-29T00:00:00Z' },
  }, '2026-08-27T00:00:00Z');
  assert.ok(r);
  assert.equal(r.available, true);
  assert.equal(r.fiveHour.utilization, 41);
  assert.equal(r.sevenDay.utilization, 63);
  assert.equal(r.topTier.label, 'opus');
  assert.equal(r.topTier.window.utilization, 22);
});

test('parsePayload falls back to seven_day_sonnet for the top tier, labeled sonnet', () => {
  const r = parsePayload({
    five_hour: { utilization: 5, resets_at: null },
    seven_day: { utilization: 10, resets_at: null },
    seven_day_sonnet: { utilization: 8, resets_at: null },
  }, 'now');
  assert.equal(r.topTier.label, 'sonnet');
  assert.equal(r.topTier.window.utilization, 8);
});

test('parsePayload rejects a payload with no recognizable window (contract change)', () => {
  assert.equal(parsePayload({ something_else: 1 }, 'now'), null);
  assert.equal(parsePayload(null, 'now'), null);
});
