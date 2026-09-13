// Unit tests for src/analytics/projectAggregates.ts (#376): the one
// assembler behind the project Overview. Fixture `ProjectDetailResult` in,
// render-ready result out — the seam is the function's return, never React
// rendering (the page is a template over this shape).
//
// Same style as test/ranged-usage-client.test.mjs and test/insights-stats.test.mjs:
// node --test over the `.ts` module directly, via Node's type stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectAggregates } from '../src/analytics/projectAggregates.ts';

// Every day key this module produces is a LOCAL calendar day
// (src/charts/timeBuckets.ts), so fixtures build their timestamps from local
// parts: the assertions then hold in any TZ the suite runs in.
function localIso(y, mo, d, h = 12) {
  return new Date(y, mo - 1, d, h).toISOString();
}

function cell(input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) {
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

// A day-bucketed ranged cell, exactly as server/rangeUsage.ts ships it on
// `/api/projects/:id` analytics.rangedTokensByModel.
function bucketed(sessionId, model, bucket, cells, source = 'claude-code') {
  return { sessionId, projectId: 1, model, source, bucket, cells };
}

function session(id, over = {}) {
  return {
    id,
    source: 'claude-code',
    started_at: null,
    ended_at: null,
    message_count: 0,
    first_prompt: null,
    name: null,
    summary: null,
    context_tokens: null,
    usage: null,
    agent_active_ms: null,
    char_count: null,
    liveCandidate: false,
    ongoing: false,
    ...over,
  };
}

function result({ sessions = [], analytics = {} } = {}) {
  return {
    project: { id: 1, name: 'chronicle', path: '/tmp/chronicle' },
    sessions,
    git: { isRepo: false, branch: null },
    analytics: {
      toolDist: [],
      kindDist: [],
      activity: [],
      errors: 0,
      rangedTokensByModel: [],
      commits: 0,
      ...analytics,
    },
  };
}

test('KPI totals: counts come off the scoped aggregates, tokens and cost off the ranged cells', () => {
  const data = result({
    sessions: [
      session('s1', { started_at: localIso(2026, 9, 1, 9), agent_active_ms: 60_000 }),
      // No agent_active_ms: wall clock start→end is the documented fallback.
      session('s2', { started_at: localIso(2026, 9, 3, 9), ended_at: localIso(2026, 9, 3, 11) }),
    ],
    analytics: {
      kindDist: [{ kind: 'tool_use', count: 10 }, { kind: 'user', count: 4 }, { kind: 'assistant', count: 6 }],
      errors: 2,
      rangedTokensByModel: [
        // claude-sonnet-5 after its intro window: $3/1M in, $15/1M out.
        bucketed('s1', 'claude-sonnet-5', '2026-09-01', cell(1_000_000, 200_000)),
        // claude-opus (default tier): $5/1M in, $25/1M out.
        bucketed('s2', 'claude-opus', '2026-09-03', cell(0, 100_000)),
      ],
    },
  });

  const agg = projectAggregates(data, 'theoretical');

  assert.equal(agg.toolCalls, 10);
  assert.equal(agg.messages, 20);
  assert.equal(agg.userPrompts, 4);
  assert.equal(agg.errors, 2);
  assert.equal(agg.errorRate, 20);
  assert.equal(agg.activeDays, 2);
  assert.equal(agg.activeMs, 60_000 + 2 * 3_600_000);
  assert.equal(agg.totalIn, 1_000_000);
  assert.equal(agg.totalOut, 300_000);
  assert.equal(agg.totalTokens, 1_300_000);
  assert.equal(agg.modelCount, 2);
  // sonnet 1M in + 0.2M out = $3 + $3 = $6; opus 0.1M out = $2.50.
  assert.equal(agg.totalCost, 8.5);
});

test('KPI totals: an empty project reports zeroes, not NaN (error rate has no tool calls to divide by)', () => {
  const agg = projectAggregates(result(), 'theoretical');
  assert.equal(agg.errorRate, 0);
  assert.equal(agg.totalCost, 0);
  assert.equal(agg.modelCount, 0);
});
