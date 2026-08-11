import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore;

// Divergence from the brief's literal fixture code (same pattern as
// test/insights.test.mjs's documented divergence): the brief's `rhythmEvents`
// hardcodes model:'claude-sonnet-5' on every assistant message, but s2's
// `usage` JSON claims 'claude-haiku-4-5' and group-by-model is message-exact
// (per-message m.model, not the session usage aggregate) — so without a
// per-session model override, no message row would ever carry
// 'claude-haiku-4-5' and `r.rows.some(x => x.key === 'claude-haiku-4-5')`
// could never pass regardless of implementation. Added a `model` param
// (default 'claude-sonnet-5', unchanged for s1) so s2's fixture messages
// actually carry the model its usage aggregate claims.
function rhythmEvents(baseIso, extra = [], model = 'claude-sonnet-5') {
  const base = new Date(baseIso).getTime();
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: new Date(base + i * 2 * 60000).toISOString(),
      ...(i % 2 === 1 ? { model, input_tokens: 100, output_tokens: 50 } : {}),
    });
  }
  return [...events, ...extra];
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p1 = upsertProject('/tmp/proj-a');
  const p2 = upsertProject('/tmp/proj-b');
  replaceSession(
    { id: 's1', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s1.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 600, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 't1', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't1', text: 'ok output text', ts: '2026-08-01T10:24:03.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose',
        input_tokens: 200, output_tokens: 80, text: 'subagent work here', ts: '2026-08-01T10:25:00.000Z' },
    ]),
  );
  replaceSession(
    { id: 's2', project_id: p2.id, source: 'codex', file_path: '/tmp/s2.jsonl',
      started_at: '2026-08-02T03:00:00.000Z', ended_at: '2026-08-02T03:30:00.000Z',
      usage: JSON.stringify({ 'claude-haiku-4-5': { input: 40, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-02T03:00:00.000Z', [], 'claude-haiku-4-5'),
  );
});
after(() => teardown());

test('computeExplore: group by model returns exact token cells, not calibrated', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, false);
  const sonnet = r.rows.find((x) => x.key === 'claude-sonnet-5');
  assert.ok(sonnet);
  assert.ok(sonnet.tokensByModel['claude-sonnet-5'].input > 0);
  assert.ok(r.rows.some((x) => x.key === 'claude-haiku-4-5'));
});

test('computeExplore: scope=project filters to one project', () => {
  const r = explore.computeExplore({ scope: { type: 'project', id: 1 }, days: null, metric: 'requests', group: 'source', rollup: 'total', topN: 10 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'claude-code');
});

test('computeExplore: group by subagent is EXACT (sidechain agent_type + per-message tokens)', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'subagent', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, false);
  const gp = r.rows.find((x) => x.key === 'general-purpose');
  assert.ok(gp);
  assert.equal(gp.tokensByModel['claude-sonnet-5'].input, 200);
});

test('computeExplore: group by tool is CALIBRATED', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  assert.ok(r.rows.some((x) => x.key === 'Bash'));
});

test('computeExplore: subgroup produces stacked segments summing to the row total tokens', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', subgroup: 'project', rollup: 'total', topN: 10 });
  const sonnet = r.rows.find((x) => x.key === 'claude-sonnet-5');
  const segSum = sonnet.segments.reduce((n, s) => n + s.tokens, 0);
  const rowTokens = Object.values(sonnet.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(segSum, rowTokens);
});

test('computeExplore: topN caps rows and folds the rest into an "Other" row', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'requests', group: 'model', rollup: 'total', topN: 1 });
  assert.ok(r.rows.length <= 2);
  assert.ok(r.rows.some((x) => x.key === 'Other') || r.rows.length === 1);
});
