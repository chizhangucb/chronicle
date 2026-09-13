// The paired-tool_use rule, read through the engines that pair a tool_result
// back to the tool_use it answers (#378): Explore's error attribution,
// Content's tool-result attribution and Waste's repeat file reads all take the
// join from ONE builder, so a session that carries the same `tool_use_id` on
// more than one row is read the same way everywhere: the pair is the EARLIEST
// matching row in the SAME session, and there is exactly one of it.
//
// Own temp DB, so this file's duplicate-id fixture cannot perturb the engine
// suites that assert totals over their own fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

let dbModule, teardown, waste, explore, content;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MODEL = 'claude-sonnet-5';
// 12 alternating messages over 22 minutes, so the session clears both
// noise-gate thresholds and minorGate does not hide it from 'all' scope.
const rhythm = (baseMs) => Array.from({ length: 12 }, (_, i) => ({
  kind: i % 2 === 0 ? 'user' : 'assistant',
  text: `msg ${i}`,
  ts: iso(baseMs + i * 2 * 60000),
  ...(i % 2 === 1 ? { model: MODEL, input_tokens: 100, output_tokens: 50 } : {}),
}));

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  waste = await import('../server/waste.ts');
  explore = await import('../server/explore.ts');
  content = await import('../server/content.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/proj-paired-join');
  const base = now - 3600000;

  // /x.ts is read twice, so one re-read. The second Read's result arrives TWICE
  // under the same tool_use_id (a transcript that repeats the result line),
  // which is the shape that tells a deduped pairing from a fan-out one.
  replaceSession(
    { id: 'paired', project_id: p.id, source: 'claude-code', file_path: '/tmp/paired.jsonl',
      started_at: iso(base), ended_at: iso(base + 22 * 60000),
      usage: JSON.stringify({ [MODEL]: { input: 1000, output: 500 } }) },
    [
      ...rhythm(base),
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'p1', text: 'read', ts: iso(base + 300), tool_input: JSON.stringify({ file_path: '/x.ts' }) },
      { kind: 'tool_result', tool_use_id: 'p1', text: 'X'.repeat(400), ts: iso(base + 310) },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'p2', text: 'read', ts: iso(base + 400), tool_input: JSON.stringify({ file_path: '/x.ts' }) }, // RE-READ
      { kind: 'tool_result', tool_use_id: 'p2', text: 'X'.repeat(400), ts: iso(base + 410) },
      { kind: 'tool_result', tool_use_id: 'p2', text: 'X'.repeat(400), ts: iso(base + 420) }, // repeated result line
      // The mirror shape: the CALL written twice under one id (a transcript
      // line re-appended after a resume), the second copy naming a different
      // tool. The pair is the earliest, so the error below is Bash's, once.
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'p3', text: 'run', ts: iso(base + 500) },
      { kind: 'tool_use', tool_name: 'Grep', tool_use_id: 'p3', text: 'run', ts: iso(base + 505) },
      { kind: 'tool_result', tool_use_id: 'p3', text: `Error: ${'b'.repeat(400)}`, ts: iso(base + 510) },
    ],
  );
});
after(async () => { await teardown?.(); });

test('repeat-read waste pairs a Read with ONE result, so a repeated result line does not double the re-read', () => {
  const w = waste.computeWaste({ type: 'all' }, rangeOf(null));
  assert.equal(w.rereads.rereadCalls, 1);          // /x.ts read twice → 1 re-read
  assert.equal(w.rereads.sessionsAffected, 1);
  assert.equal(w.rereads.topFiles[0].path, '/x.ts');
  assert.equal(w.rereads.topFiles[0].rereads, 1);
  // 400 chars of re-read result / 4, counted once and not once per result row.
  assert.equal(w.rereads.estWastedTokens, 100);
});

const errorQuery = { scope: { type: 'all' }, range: rangeOf(null), metric: 'errors', topN: 10 };

test('Explore attributes an erroring result to the EARLIEST tool_use carrying its id, once', () => {
  const r = explore.computeExplore({ ...errorQuery, group: 'tool', rollup: 'total' });
  assert.equal(r.rows.find((x) => x.key === 'Bash')?.errors, 1);
  assert.equal(r.rows.find((x) => x.key === 'Grep')?.errors ?? 0, 0,
    'the later copy of the call is not a second pair');
  assert.equal(r.rows.reduce((n, x) => n + x.errors, 0), 1);
});

test('the Explore error rollup pairs the same way, so its buckets sum to the row', () => {
  const r = explore.computeExplore({ ...errorQuery, group: 'tool', rollup: 'daily' });
  const bucketTotal = (r.buckets ?? []).reduce(
    (n, b) => n + Object.values(b.series).reduce((m, cell) => m + cell.errors, 0), 0);
  assert.equal(bucketTotal, 1);
});

test('Content attributes result text to the earliest paired tool_use tool_name', () => {
  const r = content.computeContent({ type: 'all' }, rangeOf(null));
  assert.ok((r.toolResultsByTool.find((x) => x.key === 'Bash')?.tokens ?? 0) > 0,
    'the 400-char error result belongs to the Bash call that came first');
  assert.equal(r.toolResultsByTool.find((x) => x.key === 'Grep'), undefined,
    'the later copy of the call is attributed nothing');
});
