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
      // Second Bash call that errors — for the errors-metric fix (Finding 1,
      // 5e-0 review round). Paired via tool_use_id 't2', same tool_name as
      // the ok one above, so the 'Bash' row must show errors===1 (only this
      // one), not 2 (double-counting the ok result) or the session's full
      // message count (the old cross-join bug).
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 't2', ts: '2026-08-01T10:26:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't2', text: 'Error: boom', ts: '2026-08-01T10:26:03.000Z' },
      // Locks the tool_input calibration-char-source fix (5e-1 code review):
      // real tool_use rows carry their content in tool_input, NOT text (text
      // is null/absent here, matching production JSONL) — before the fix,
      // the calibrated char measure summed LENGTH(text) only, so this row
      // contributed 0 chars and its calibrated tokens came out 0 regardless
      // of scope/date range. Paired with a NON-erroring tool_result so this
      // doesn't perturb the errors-by-source/tool assertions elsewhere.
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't3',
        tool_input: JSON.stringify({ cmd: 'ls -la /some/long/path' }), ts: '2026-08-01T10:27:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't3', text: 'read ok', ts: '2026-08-01T10:27:03.000Z' },
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

// Locks Finding 1 (5e-0 review): errors must be counted ONCE per erroring
// tool_result, attributed via tool_use_id pairing — not cross-joined against
// every tool_result co-resident in the session.
test('computeExplore: errors for group=tool count only the erroring tool_result, not the ok one', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'errors', group: 'tool', rollup: 'total', topN: 10 });
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  assert.equal(bash.errors, 1);
});

// Locks the multiplicative-over-count regression specifically: for
// group=source, g.where is '' so `m`/`r` range over every message kind in
// the session — the old cross-join counted errors once per co-resident
// message (17 in this fixture's s1), not once per erroring tool_result.
test('computeExplore: errors for group=source are NOT multiplied by session message count', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'errors', group: 'source', rollup: 'total', topN: 10 });
  const cc = r.rows.find((x) => x.key === 'claude-code');
  assert.ok(cc);
  assert.equal(cc.errors, 1);
});

// Locks Finding 2 (5e-0 review): calibrated tool/skill rows must blend
// tokens across the scope's REAL models (costOf(model) can price them), not
// collapse into a single ''-keyed cell (costOf('') is null per src/models.ts
// pricingFor's falsy-model guard).
test('computeExplore: calibrated tool rows blend tokens across REAL models, never a "" key', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  const modelKeys = Object.keys(bash.tokensByModel);
  assert.ok(modelKeys.length > 0);
  assert.ok(!modelKeys.includes(''));
  assert.ok(modelKeys.includes('claude-sonnet-5') || modelKeys.includes('claude-haiku-4-5'));
});

// Locks Finding 5 (5e-0 review): calibrated groups skip subgroup segments
// entirely (raw per-row token sums would be near-zero and misleading).
test('computeExplore: calibrated groups (tool/skill) leave segments empty even when subgroup is requested', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', subgroup: 'project', rollup: 'total', topN: 10 });
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  assert.deepEqual(bash.segments, []);
});

// Regression test for the tool_input calibration-char-source bug (5e-1 code
// review, fixed in server/explore.ts): tool_use rows carry their content in
// tool_input, not text — the 't3' fixture row above has text null/absent and
// a non-empty tool_input. Before the fix, the char-length query summed
// LENGTH(text) only, so every tool_use row contributed 0 chars,
// calibrateByBucket's totalChars was 0, and EVERY calibrated tool/skill row
// came out 0 tokens regardless of scope/date range — the prior test only
// checked the 'Bash' row EXISTS (and that its tokensByModel keys are real
// model names), never that its token VALUES were nonzero, so the bug slipped
// through review. This asserts the 'Read' row (t3) has real positive tokens.
test('computeExplore: calibrated tool tokens are nonzero (tool_input counts as char source, not just text)', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  const read = r.rows.find((x) => x.key === 'Read');
  assert.ok(read);
  const totalTokens = Object.values(read.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.ok(totalTokens > 0, `expected 'Read' row tokens > 0, got ${totalTokens}`);
});
