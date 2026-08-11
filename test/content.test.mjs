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
  // DIVERGENCE (the crux of the reconcile fix): per-message assistant tokens
  // total 1230 (6×(100+40) main + 300+90 sidechain), but the session `usage`
  // JSON claims 1000/500 (=1500) — the authoritative billed truth. The
  // calibration base + calibratedTotalTokens must read the 1500 usage total,
  // not the 1230 per-message sum, so the divergence proves the source.
  replaceSession(
    { id: 's1', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s1.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't1', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't1', text: 'x'.repeat(500), ts: '2026-08-01T10:24:03.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 300, output_tokens: 90, ts: '2026-08-01T10:25:00.000Z' },
      // A small skill slice — a genuine FRACTION of all content (~30 chars of
      // ~780). Under the old bug (calibrateByBucket over ONLY skill buckets) its
      // lone bucket summed to the FULL billed total (1500); the fix normalizes
      // by all-content chars so it lands at its true share (~57).
      { kind: 'assistant', model: 'claude-sonnet-5', skill: 'code-review', text: 'short skill invocation body', ts: '2026-08-01T10:26:00.000Z' },
    ]),
  );
  // sMinor: 4 messages (below the <10 msg noise-gate threshold) → minor=1.
  // Session scope must ignore the minor gate and still return content.
  replaceSession(
    { id: 'sMinor', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sMinor.jsonl',
      started_at: '2026-08-02T10:00:00.000Z', ended_at: '2026-08-02T10:02:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 300, output: 150, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'user', text: 'hi', ts: '2026-08-02T10:00:00.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, text: 'reply', ts: '2026-08-02T10:00:30.000Z' },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'm1', tool_input: JSON.stringify({ path: '/x' }), ts: '2026-08-02T10:01:00.000Z' },
      { kind: 'tool_result', tool_use_id: 'm1', text: 'file contents here', ts: '2026-08-02T10:01:03.000Z' },
    ],
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

// calibratedTotalTokens (the calibration base + Shakespeare footnote) reconciles
// to Σ in-scope sessions.usage(input+output) = the Insights Tokens KPI — NOT the
// per-message assistant sum (1230). Fixture usage diverges (1500) to prove it.
test('computeContent: calibratedTotalTokens === Σ sessions.usage(input+output), not per-message', () => {
  const r = content.computeContent({ type: 'all' }, null);
  assert.equal(r.calibratedTotalTokens, 1500); // 1000 input + 500 output from usage (not 1230 per-message)
  // composition shares still track that calibrated total (±rounding across buckets).
  const sum = r.composition.reduce((n, c) => n + c.tokens, 0);
  assert.ok(Math.abs(sum - 1500) <= 2, `composition sum ${sum} should be ~1500`);
});

// FINDING 1 (reconcile): toolResultsByTool must be the TRUE fraction of billed —
// normalized by ALL-content chars, not by its own bucket sum. The old code
// (calibrateByBucket over only tool-result buckets) summed to the ENTIRE billed
// total, implying tool-results = 100% of usage. RED→GREEN: the two assertions
// below FAIL under the pre-fix code (Σ == billed == calibratedTotalTokens).
test('computeContent: Σ toolResultsByTool ≤ composition tool_result bucket AND < calibratedTotalTokens (not inflated to full billed)', () => {
  const r = content.computeContent({ type: 'all' }, null);
  const toolSum = r.toolResultsByTool.reduce((n, x) => n + x.tokens, 0);
  const compToolResult = r.composition.find((c) => c.key === 'tool_result')?.tokens ?? 0;
  assert.ok(toolSum > 0, 'expect some tool-result tokens attributed');
  assert.ok(toolSum <= compToolResult, `Σ toolResultsByTool ${toolSum} must be ≤ composition tool_result bucket ${compToolResult}`);
  assert.ok(toolSum < r.calibratedTotalTokens, `Σ toolResultsByTool ${toolSum} must be < calibratedTotalTokens ${r.calibratedTotalTokens} (old code inflated it to the full billed total)`);
});

// FINDING 1 (reconcile): a small skill slice must render as its true fraction of
// billed, NOT ~100%. RED→GREEN: fails under the pre-fix code (skillSum == 1500).
test('computeContent: Σ skills tokens < calibratedTotalTokens when skills are a content subset', () => {
  const r = content.computeContent({ type: 'all' }, null);
  const skillSum = r.skills.reduce((n, s) => n + s.tokens, 0);
  assert.ok(skillSum > 0, 'expect the code-review skill fixture to attribute some tokens');
  assert.ok(skillSum < r.calibratedTotalTokens, `Σ skills ${skillSum} must be < calibratedTotalTokens ${r.calibratedTotalTokens} (old code inflated it to full billed)`);
});

test('session-scope Content is populated for a minor session', async () => {
  // sMinor: 4 messages (below the <10 msg noise-gate threshold) → minor=1.
  // Session scope must ignore the minor gate and still return content.
  const r = content.computeContent({ type: 'session', id: 'sMinor' }, null);
  assert.ok(r.calibratedTotalTokens > 0, 'minor session should still surface billed tokens under session scope');
  assert.ok(r.composition.some((c) => c.tokens > 0), 'composition should be non-empty for a directly-opened minor session');
});
