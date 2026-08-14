// Unit tests for src/windowedUsage.ts (feedback-round Task 3): the client-side
// aggregation over server/windowUsage.ts's WindowedUsageCell/BucketedUsageCell
// arrays (`/api/insights` windowedTokensByModel/dailySpend/hourlySpend,
// `/api/projects/:id` analytics.windowedTokensByModel) — grouping by
// model/key/bucket and pricing via src/models.ts costOf, WITHOUT ever
// flattening different models' tokens together before pricing (each model has
// its own $/token rate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sumByModel, sumByKeyModel, groupByBucket, costOfCells, tokensOfCells, sumFields,
} from '../src/windowedUsage.ts';
import { costOf } from '../src/models.ts';

function cell(input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) {
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

// claude-sonnet-5: $3/1M input, $15/1M output (src/models.ts PRICING).
// claude-opus (default tier): $5/1M input, $25/1M output.
const sonnetCellA = { sessionId: 's1', projectId: 1, model: 'claude-sonnet-5', source: 'claude-code', cells: cell(1_000_000, 0) };
const sonnetCellB = { sessionId: 's2', projectId: 2, model: 'claude-sonnet-5', source: 'claude-code', cells: cell(1_000_000, 0) };
const opusCellA = { sessionId: 's1', projectId: 1, model: 'claude-opus', source: 'claude-code', cells: cell(0, 1_000_000) };

test('sumByModel: merges cells across sessions/projects/sources into one bag per model', () => {
  const byModel = sumByModel([sonnetCellA, sonnetCellB, opusCellA]);
  assert.equal(byModel.size, 2);
  assert.equal(byModel.get('claude-sonnet-5').input, 2_000_000);
  assert.equal(byModel.get('claude-opus').output, 1_000_000);
});

test('costOfCells: prices each model at ITS OWN rate before summing (never flattens tokens across models)', () => {
  const byModel = sumByModel([sonnetCellA, opusCellA]);
  // sonnet: 1M input @ $3/1M = $3. opus: 1M output @ $25/1M = $25. Total $28 —
  // NOT priced as if 2M combined tokens were all one model.
  assert.equal(costOfCells(byModel), 3 + 25);
  assert.equal(costOfCells(byModel), (costOf('claude-sonnet-5', sonnetCellA.cells) ?? 0) + (costOf('claude-opus', opusCellA.cells) ?? 0));
});

test('costOfCells: undefined map (e.g. a session with no windowed cells) is $0, not a throw', () => {
  assert.equal(costOfCells(undefined), 0);
});

test('tokensOfCells: input + output only, cache tokens excluded (separate billing tier)', () => {
  const byModel = sumByModel([
    { sessionId: 's1', projectId: 1, model: 'claude-sonnet-5', source: 'claude-code', cells: cell(100, 50, 999, 999, 999) },
  ]);
  assert.equal(tokensOfCells(byModel), 150);
});

test('sumByKeyModel: groups by an arbitrary key (e.g. sessionId) while preserving per-model breakdown', () => {
  const byKeyModel = sumByKeyModel([sonnetCellA, sonnetCellB, opusCellA], (c) => c.sessionId);
  assert.deepEqual([...byKeyModel.keys()].sort(), ['s1', 's2']);
  // s1 has BOTH sonnet and opus cells — costOfCells must price them separately.
  assert.equal(costOfCells(byKeyModel.get('s1')), 3 + 25);
  assert.equal(costOfCells(byKeyModel.get('s2')), 3);
});

test('sumByKeyModel: grouping by projectId (id coerced to string) supports the Home top-5-projects ranking', () => {
  const byProject = sumByKeyModel([sonnetCellA, sonnetCellB, opusCellA], (c) => String(c.projectId));
  assert.equal(costOfCells(byProject.get('1')), 3 + 25); // project 1: sonnetCellA + opusCellA
  assert.equal(costOfCells(byProject.get('2')), 3); // project 2: sonnetCellB only
});

test('groupByBucket: splits a bucketed cell list into one raw list per bucket key', () => {
  const bucketed = [
    { ...sonnetCellA, bucket: '2026-08-13' },
    { ...opusCellA, bucket: '2026-08-13' },
    { ...sonnetCellB, bucket: '2026-08-14' },
  ];
  const byBucket = groupByBucket(bucketed);
  assert.deepEqual([...byBucket.keys()].sort(), ['2026-08-13', '2026-08-14']);
  assert.equal(byBucket.get('2026-08-13').length, 2);
  assert.equal(byBucket.get('2026-08-14').length, 1);
});

test('sumFields: flattens a per-model map into one raw (unpriced) cell — safe for non-priced totals like input/cacheRead', () => {
  const byModel = sumByModel([sonnetCellA, opusCellA]);
  const total = sumFields(byModel);
  assert.equal(total.input, 1_000_000);
  assert.equal(total.output, 1_000_000);
});

test('sumFields: undefined map returns a zeroed cell, not a throw', () => {
  assert.deepEqual(sumFields(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});
