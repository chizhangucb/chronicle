// server/explore.ts's default (rollup='total') EXACT_USAGE_GROUPS rows
// (model/project/source/session) must carry a day-bucketed breakdown of
// tokensByModel so the client can price a range that straddles a rate change
// (e.g. Sonnet 5's intro window, cutover 2026-08-31) correctly per day
// instead of one flat rate for the whole range. Isolated fixture (own temp DB,
// own project) rather than the shared test/explore.test.mjs `before()` fixture,
// which already has interlocking hardcoded sonnet-5 token totals a new
// sonnet-5-bearing session would perturb.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/cutover-proj');

  // Session entirely BEFORE the cutover: 1M input tokens on 2026-08-15.
  replaceSession(
    { id: 'pre', project_id: p.id, source: 'claude-code', file_path: '/tmp/pre.jsonl',
      started_at: '2026-08-15T10:00:00.000Z', ended_at: '2026-08-15T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-08-15T10:05:00.000Z', text: 'a' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-08-15T10:10:00.000Z', text: 'b' },
    ],
  );
  // Session entirely AFTER the cutover: 1M input tokens on 2026-09-01.
  replaceSession(
    { id: 'post', project_id: p.id, source: 'claude-code', file_path: '/tmp/post.jsonl',
      started_at: '2026-09-01T10:00:00.000Z', ended_at: '2026-09-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-09-01T10:05:00.000Z', text: 'c' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-09-01T10:10:00.000Z', text: 'd' },
    ],
  );
});

after(async () => { teardown?.(); });

test('computeExplore(group=model, rollup=total): tokensByModelByDay splits the range total by LOCAL day', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  const sonnet = r.rows.find((row) => row.key === 'claude-sonnet-5');
  assert.ok(sonnet, 'sonnet-5 row must be present');
  assert.ok(sonnet.tokensByModelByDay, 'model group (an EXACT_USAGE_GROUPS group) must carry tokensByModelByDay');

  assert.equal(sonnet.tokensByModelByDay['2026-08-15']['claude-sonnet-5'].input, 1_000_000);
  assert.equal(sonnet.tokensByModelByDay['2026-09-01']['claude-sonnet-5'].input, 1_000_000);

  // Reconciliation invariant: summing tokensByModelByDay across every day must
  // reproduce the flat tokensByModel total exactly (mirrors the reconciliation
  // pattern test/ranged-routes.test.mjs already enforces server-wide).
  const byDaySum = Object.values(sonnet.tokensByModelByDay)
    .reduce((n, byModel) => n + Object.values(byModel).reduce((m, c) => m + c.input + c.output, 0), 0);
  const flatTotal = Object.values(sonnet.tokensByModel).reduce((n, c) => n + c.input + c.output, 0);
  assert.equal(byDaySum, flatTotal);
  assert.equal(flatTotal, 2_000_000);
});
