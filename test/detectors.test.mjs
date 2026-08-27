// CHI-324 2e: computeDetectors counts the per-message inputs the Efficiency
// detectors grade (jumbo outputs > 3k, long context input+cacheRead > 150k, and
// the cache-hit token sums), windowed by message ts. Server ships COUNTS; the
// client derives + grades the rates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, detectors;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;
const MODEL = 'claude-sonnet-5';
// Non-minor requires >= 10 events (noiseGate). Pad with plain user turns — they
// are not assistant rows, so the detector counts stay exact.
const filler = (baseMs) => Array.from({ length: 11 }, (_, i) => ({ kind: 'user', text: `u${i}`, ts: iso(baseMs + 100 + i) }));

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  detectors = await import('../server/detectors.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/proj-det');

  // Main session (1h ago): 4 assistant rows — one jumbo (output 5000 > 3000),
  // one long-context (input+cacheRead = 200k > 150k), two ordinary.
  const base = now - 3600000;
  replaceSession(
    { id: 'sd', project_id: p.id, source: 'claude-code', file_path: '/tmp/sd.jsonl',
      started_at: iso(base), ended_at: iso(base + 5000),
      usage: JSON.stringify({ [MODEL]: { input: 102000, output: 5400, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 105000 } }) },
    [
      { kind: 'user', text: 'hi', ts: iso(base) },
      { kind: 'assistant', model: MODEL, text: 'a1', ts: iso(base + 1000), output_tokens: 5000, input_tokens: 1000, cache_read_tokens: 0 },
      { kind: 'assistant', model: MODEL, text: 'a2', ts: iso(base + 2000), output_tokens: 100, input_tokens: 100000, cache_read_tokens: 100000 },
      { kind: 'assistant', model: MODEL, text: 'a3', ts: iso(base + 3000), output_tokens: 100, input_tokens: 500, cache_read_tokens: 2000 },
      { kind: 'assistant', model: MODEL, text: 'a4', ts: iso(base + 4000), output_tokens: 200, input_tokens: 500, cache_read_tokens: 3000 },
      ...filler(base + 5000),
    ],
  );
  // Old session (2 days ago): 1 assistant row, ordinary — outside the 1d window.
  const old = now - 2 * DAY;
  replaceSession(
    { id: 'sold', project_id: p.id, source: 'claude-code', file_path: '/tmp/sold.jsonl',
      started_at: iso(old), ended_at: iso(old + 1000),
      usage: JSON.stringify({ [MODEL]: { input: 500, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [{ kind: 'assistant', model: MODEL, text: 'old', ts: iso(old + 500), output_tokens: 100, input_tokens: 500, cache_read_tokens: 0 }, ...filler(old + 1000)],
  );
});
after(async () => { await teardown?.(); });

test('computeDetectors: jumbo + long-context + cache/input token sums (All window)', () => {
  const d = detectors.computeDetectors(null);
  assert.equal(d.assistantRows, 5);           // 4 recent + 1 old
  assert.equal(d.jumboRows, 1);               // only the 5000-output row (> 3000)
  assert.equal(d.longContextRows, 1);         // only the 200k-context row (> 150k)
  assert.equal(d.inputTokens, 1000 + 100000 + 500 + 500 + 500);
  assert.equal(d.cacheReadTokens, 0 + 100000 + 2000 + 3000 + 0);
});

test('computeDetectors: windows by message ts (1d excludes the 2-day-old row)', () => {
  const d = detectors.computeDetectors(1);
  assert.equal(d.assistantRows, 4);           // old session dropped
  assert.equal(d.jumboRows, 1);
  assert.equal(d.longContextRows, 1);
});
