// CHI-324 2e: computeWaste — cache churn (write>read), right-sizing candidates
// (small premium-model turns), and repeated file reads. Server ships token
// cells + counts; the client prices. These assert the DETECTION, not dollars.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, waste;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MODEL = 'claude-opus-4-8'; // premium (input rate >= 5)
const filler = (baseMs) => Array.from({ length: 11 }, (_, i) => ({ kind: 'user', text: `u${i}`, ts: iso(baseMs + i) }));

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  waste = await import('../server/waste.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/proj-waste');
  const base = now - 3600000;

  // Session A — CHURN: wrote more cache than it read (cw5m+cw1h > cacheRead).
  replaceSession(
    { id: 'churn', project_id: p.id, source: 'claude-code', file_path: '/tmp/churn.jsonl',
      started_at: iso(base), ended_at: iso(base + 5000),
      usage: JSON.stringify({ [MODEL]: { input: 100, output: 100, cacheWrite5m: 50000, cacheWrite1h: 50000, cacheRead: 1000 } }) },
    [
      { kind: 'assistant', model: MODEL, text: 'a', ts: iso(base + 100), input_tokens: 100, output_tokens: 100, cache_read_tokens: 1000, cache_w5m_tokens: 50000, cache_w1h_tokens: 50000 },
      // Small premium turn → right-sizing candidate (output < 300, ctx < 50k).
      { kind: 'assistant', model: MODEL, text: 'b', ts: iso(base + 200), input_tokens: 200, output_tokens: 100, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      // A Read of file X, then a RE-READ of file X → 1 reread; file Y read once.
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'r1', text: 'read', ts: iso(base + 300), tool_input: JSON.stringify({ file_path: '/x.ts' }) },
      { kind: 'tool_result', tool_use_id: 'r1', text: 'X'.repeat(400), ts: iso(base + 310) },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'r2', text: 'read', ts: iso(base + 400), tool_input: JSON.stringify({ file_path: '/y.ts' }) },
      { kind: 'tool_result', tool_use_id: 'r2', text: 'Y'.repeat(100), ts: iso(base + 410) },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'r3', text: 'read', ts: iso(base + 500), tool_input: JSON.stringify({ file_path: '/x.ts' }) }, // RE-READ
      { kind: 'tool_result', tool_use_id: 'r3', text: 'X'.repeat(400), ts: iso(base + 510) },
      ...filler(base + 1000),
    ],
  );
  // Session B — NOT churn: read more than it wrote. Also a big turn (not right-sizing).
  replaceSession(
    { id: 'nochurn', project_id: p.id, source: 'claude-code', file_path: '/tmp/nochurn.jsonl',
      started_at: iso(base + 20000), ended_at: iso(base + 25000),
      usage: JSON.stringify({ [MODEL]: { input: 100, output: 5000, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 90000 } }) },
    [
      { kind: 'assistant', model: MODEL, text: 'c', ts: iso(base + 20100), input_tokens: 100, output_tokens: 5000, cache_read_tokens: 90000, cache_w5m_tokens: 1000, cache_w1h_tokens: 0 },
      ...filler(base + 21000),
    ],
  );
});
after(async () => { await teardown?.(); });

test('cache churn flags a session that wrote more cache than it read', () => {
  const w = waste.computeWaste(null);
  assert.equal(w.cacheChurn.sessionsFlagged, 1);
  assert.equal(w.cacheChurn.top[0].session, 'churn');
  assert.ok(w.cacheChurn.top[0].writeTokens > w.cacheChurn.top[0].readTokens);
  // per-model cells shipped for client pricing
  assert.ok(w.cacheChurn.top[0].byModel[MODEL].cw1h > 0);
});

test('right-sizing collects the small premium-model turns', () => {
  const w = waste.computeWaste(null);
  const m = w.rightSizing.candidates.find((c) => c.model === MODEL);
  assert.ok(m, 'premium model has small-turn candidates');
  // Two small turns in session churn (output 100 each, ctx < 50k); session B's
  // 5000-output turn is excluded.
  assert.equal(m.messages, 2);
});

test('repeated file reads counts a re-read, not the first read', () => {
  const w = waste.computeWaste(null);
  assert.equal(w.rereads.rereadCalls, 1);          // /x.ts read twice → 1 reread
  assert.equal(w.rereads.sessionsAffected, 1);
  assert.equal(w.rereads.topFiles[0].path, '/x.ts');
  // wasted tokens estimated from the re-read result's chars (400) / 4.
  assert.equal(w.rereads.estWastedTokens, 100);
});
