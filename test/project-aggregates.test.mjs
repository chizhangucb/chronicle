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
  // Nothing to densify between: an empty trend, not a phantom day.
  assert.deepEqual(agg.trend, []);
});

test('cost by model: each model priced at its own rate, sorted desc, cut to the top N', () => {
  // One output-only cell per model, sized so every model's dollar figure is
  // distinct: $50, $45, $40, $30, $25, $20, $15, $10, $6 (rates: src/models.ts).
  const priced = [
    ['claude-fable-5', 1_000_000, 50],
    ['claude-mythos', 900_000, 45],
    ['claude-opus', 1_600_000, 40],
    ['claude-sonnet-5', 2_000_000, 30],
    ['claude-haiku', 5_000_000, 25],
    ['gpt-5', 2_000_000, 20],
    ['gpt-4', 1_500_000, 15],
    ['gemini', 1_000_000, 10],
    ['claude-sonnet-4-5', 400_000, 6],
  ];
  const data = result({
    analytics: {
      rangedTokensByModel: priced.map(([m, out]) => bucketed('s1', m, '2026-09-01', cell(0, out))),
    },
  });

  const agg = projectAggregates(data, 'theoretical');

  assert.equal(agg.costByModel.length, 8, 'top 8 of the 9 models');
  assert.deepEqual(agg.costByModel, priced.slice(0, 8).map(([m, , cost]) => [m, cost]));
  // The cheapest model is the one cut, not silently folded into another row.
  assert.equal(agg.costByModel.find(([m]) => m === 'claude-sonnet-4-5'), undefined);
});

test('tool ranking: friendly labels, merged, with user prompts, sorted desc and cut to the top N', () => {
  const data = result({
    analytics: {
      kindDist: [{ kind: 'user', count: 4 }],
      toolDist: [
        { name: 'Bash', count: 9 },
        { name: 'Grep', count: 3 },
        // Grep and Glob share the 'Search' label, so they merge into one row.
        { name: 'Glob', count: 2 },
        { name: 'Read', count: 6 },
        { name: 'mcp__chronicle__some_very_long_tool', count: 1 },
      ],
    },
  });

  const agg = projectAggregates(data, 'theoretical');

  assert.deepEqual(agg.ranking, [
    ['Shell Command', 9],
    ['Read File', 6],
    ['Search', 5],
    ['User Prompt', 4],
    // A name too long to render is bucketed rather than blowing out the row.
    ['Other', 1],
  ]);
});

test('source split: sessions per source, sorted desc', () => {
  const data = result({
    sessions: [
      session('s1', { source: 'claude-code' }),
      session('s2', { source: 'codex' }),
      session('s3', { source: 'claude-code' }),
    ],
  });
  assert.deepEqual(projectAggregates(data, 'theoretical').sources, [['claude-code', 2], ['codex', 1]]);
});

test('trend: a session whose activity crosses local midnight is split per day, not billed to its start day', () => {
  // Regression pin for the fidelity change (#376): the project Overview used
  // to attribute a session's WHOLE cost to the local day it started on, so
  // this session read $7.50 on 09-01 and nothing on 09-02.
  const data = result({
    sessions: [session('s1', { started_at: localIso(2026, 9, 1, 23), ended_at: localIso(2026, 9, 2, 1) })],
    analytics: {
      rangedTokensByModel: [
        // claude-opus: $25/1M output.
        bucketed('s1', 'claude-opus', '2026-09-01', cell(0, 100_000)),
        bucketed('s1', 'claude-opus', '2026-09-02', cell(0, 200_000)),
      ],
    },
  });

  assert.deepEqual(projectAggregates(data, 'theoretical').trend, [
    { day: '2026-09-01', count: 1, cost: 2.5 },
    { day: '2026-09-02', count: 0, cost: 5 },
  ]);
});

test('trend: each day is priced at THAT day\'s rate, so a session across a rate change reads per day', () => {
  // claude-sonnet-5 output: $10/1M through its intro window (ends 2026-08-31),
  // $15/1M after it.
  const data = result({
    sessions: [session('s1', { started_at: localIso(2026, 8, 31, 22) })],
    analytics: {
      rangedTokensByModel: [
        bucketed('s1', 'claude-sonnet-5', '2026-08-31', cell(0, 1_000_000)),
        bucketed('s1', 'claude-sonnet-5', '2026-09-01', cell(0, 1_000_000)),
      ],
    },
  });

  const agg = projectAggregates(data, 'theoretical');
  assert.deepEqual(agg.trend.map((p) => p.cost), [10, 15]);
  assert.equal(agg.totalCost, 25);
});

test('trend: dense-filled across idle days, and a session with no billed cells still counts on its day', () => {
  const data = result({
    sessions: [
      session('s1', { started_at: localIso(2026, 9, 1, 10) }),
      // Nothing billed on 09-04: the session is still one session that day.
      session('s2', { started_at: localIso(2026, 9, 4, 10) }),
    ],
    analytics: {
      rangedTokensByModel: [bucketed('s1', 'claude-opus', '2026-09-01', cell(0, 40_000))],
    },
  });

  assert.deepEqual(projectAggregates(data, 'theoretical').trend, [
    { day: '2026-09-01', count: 1, cost: 1 },
    { day: '2026-09-02', count: 0, cost: 0 },
    { day: '2026-09-03', count: 0, cost: 0 },
    { day: '2026-09-04', count: 1, cost: 0 },
  ]);
});

test('cost basis: the same input flows through both bases, and a covered model reads about zero under Billed', () => {
  // claude-opus is subscription-covered (shared/pricing.ts); raw gpt-5 access
  // is metered, so it costs the same under either basis.
  const data = result({
    sessions: [session('s1', { started_at: localIso(2026, 9, 1, 10) })],
    analytics: {
      rangedTokensByModel: [
        bucketed('s1', 'claude-opus', '2026-09-01', cell(0, 1_000_000)),
        bucketed('s1', 'gpt-5', '2026-09-02', cell(0, 1_000_000)),
      ],
    },
  });

  const list = projectAggregates(data, 'theoretical');
  const billed = projectAggregates(data, 'real');

  assert.equal(list.totalCost, 25 + 10);
  assert.deepEqual(list.costByModel, [['claude-opus', 25], ['gpt-5', 10]]);
  assert.deepEqual(list.trend.map((p) => p.cost), [25, 10]);

  // Billed: the covered model is ~$0 everywhere it is reported, the metered
  // one is untouched, and every other figure is the same number.
  assert.equal(billed.totalCost, 10);
  assert.deepEqual(billed.costByModel, [['gpt-5', 10], ['claude-opus', 0]]);
  assert.deepEqual(billed.trend.map((p) => p.cost), [0, 10]);
  assert.equal(billed.totalTokens, list.totalTokens);
  assert.equal(billed.modelCount, list.modelCount);
});

test('the Cost KPI, the day trend and the cost-by-model split are the same dollars', () => {
  // The KPI is summed from the days the chart draws; the split is the same
  // money grouped by model instead. All three must reconcile, or the headline
  // disagrees with the bars under it.
  const data = result({
    sessions: [session('s1', { started_at: localIso(2026, 8, 31, 22) })],
    analytics: {
      rangedTokensByModel: [
        // Straddles the Sonnet 5 intro boundary AND mixes models within a day.
        bucketed('s1', 'claude-sonnet-5', '2026-08-31', cell(0, 1_000_000)),
        bucketed('s1', 'claude-opus', '2026-08-31', cell(0, 400_000)),
        bucketed('s1', 'claude-sonnet-5', '2026-09-01', cell(0, 2_000_000)),
      ],
    },
  });

  const agg = projectAggregates(data, 'theoretical');
  const sum = (ns) => ns.reduce((a, b) => a + b, 0);

  // sonnet-5: $10 (intro day) + $30 (after) = $40. opus: 0.4M out = $10.
  assert.equal(agg.totalCost, 50);
  assert.equal(sum(agg.trend.map((p) => p.cost)), agg.totalCost);
  assert.equal(sum(agg.costByModel.map(([, c]) => c)), agg.totalCost);
});

test('tool ranking: a tool named after an Object prototype key still ranks under its own name', () => {
  const data = result({ analytics: { toolDist: [{ name: 'constructor', count: 3 }] } });
  assert.deepEqual(projectAggregates(data, 'theoretical').ranking, [['constructor', 3]]);
});
