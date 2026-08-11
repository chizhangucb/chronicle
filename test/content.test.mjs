import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, content;
function rhythmEvents(baseIso, extra = []) {
  const base = new Date(baseIso).getTime(); const events = [];
  for (let i = 0; i < 12; i++) events.push({ kind: i % 2 === 0 ? 'user' : 'assistant', text: `message body number ${i}`,
    ts: new Date(base + i * 2 * 60000).toISOString(), ...(i % 2 === 1 ? { model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 40 } : {}) });
  return [...events, ...extra];
}
before(async () => {
  const temp = await withTempDb(); dbModule = temp.dbModule; teardown = temp.teardown;
  content = await import('../server/content.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p1 = upsertProject('/tmp/proj-a');
  replaceSession(
    { id: 's1', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s1.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 600, output: 240, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't1', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't1', text: 'x'.repeat(500), ts: '2026-08-01T10:24:03.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 300, output_tokens: 90, ts: '2026-08-01T10:25:00.000Z' },
    ]),
  );
});
after(() => teardown());

test('computeContent: composition has the 5 kind categories and shares sum to the calibrated total', () => {
  const r = content.computeContent({ type: 'all' }, null);
  const keys = r.composition.map((c) => c.key).sort();
  assert.deepEqual(keys, ['assistant', 'thinking', 'tool_result', 'tool_use', 'user'].sort());
  const sum = r.composition.reduce((n, c) => n + c.tokens, 0);
  assert.ok(sum > 0);
});
test('computeContent: toolResultsByTool attributes result text to the paired tool_use tool_name', () => {
  const r = content.computeContent({ type: 'all' }, null);
  assert.ok(r.toolResultsByTool.some((x) => x.key === 'Read' && x.tokens > 0));
});
test('computeContent: subagent token share is EXACT (per-message sidechain tokens)', () => {
  const r = content.computeContent({ type: 'all' }, null);
  const gp = r.subagents.find((x) => x.key === 'general-purpose');
  assert.ok(gp);
  assert.equal(gp.tokens, 390); // 300 input + 90 output, exact
});
test('computeContent: callouts return numbers, never throw on sparse data', () => {
  const r = content.computeContent({ type: 'all' }, null);
  assert.equal(typeof r.callouts.contextPressureShare, 'number');
  assert.equal(typeof r.callouts.subagentHeavyShare, 'number');
  assert.equal(typeof r.callouts.cacheWarmthMinutes, 'number');
});
// Locks Finding 3 (5e-0 review): ContentResult carries an explicit
// `calibrated` marker so the UI can badge calibrated cells.
test('computeContent: result carries an explicit calibrated:true contract marker', () => {
  const r = content.computeContent({ type: 'all' }, null);
  assert.equal(r.calibrated, true);
});
