// Unit tests for server/machineSessions.ts (CHI-233 Part C): reads the hub's
// ~/.aios/machine_sessions.jsonl manifest, normalizes each row's usage to the
// cell shape the rest of the pipeline uses, tolerates drift/blank/bad lines,
// and honors a cutoff. Same shared-temp-file pattern as test/laneC.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod, dir, file;

before(async () => {
  mod = await import('../server/machineSessions.ts');
  dir = mkdtempSync(join(tmpdir(), 'machine-'));
  file = join(dir, 'machine_sessions.jsonl');
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('readMachineSessions: parses rows, normalizes usage to cells, tolerant of drift + blanks', () => {
  writeFileSync(file, [
    '{"session_id":"a","job":"weekly","ts":"2026-08-01T06:00:00Z","model":"claude-opus","usage":{"input_tokens":100,"cache_read_tokens":50,"cache_write_tokens":20,"output_tokens":10},"cost_usd":0.42}',
    '',
    // schema drift: extra unknown field must be ignored, not break parsing
    '{"session_id":"b","job":"nightly","ts":"2026-08-02T06:00:00Z","model":"gpt-5.6-terra","usage":{"input_tokens":5,"output_tokens":2},"cost_usd":null,"extra":"ignored"}',
    'not json at all',
  ].join('\n'));
  const r = mod.readMachineSessions(null, file);
  assert.deepEqual(r.ids, ['a', 'b']); // the 2 valid rows; blank + bad line skipped
  assert.equal(r.sessions.length, 2);
  const a = r.sessions[0];
  assert.equal(a.job, 'weekly');
  assert.equal(a.model, 'claude-opus');
  // cache_write_tokens maps to the 5-minute tier; cacheWrite1h is always 0.
  assert.deepEqual(a.usage, { input: 100, output: 10, cacheRead: 50, cacheWrite5m: 20, cacheWrite1h: 0 });
  assert.equal(a.cost_usd, 0.42);
  const b = r.sessions[1];
  assert.equal(b.cost_usd, null);
  assert.deepEqual(b.usage, { input: 5, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

test('readMachineSessions: cutoff filters by ts', () => {
  const r = mod.readMachineSessions('2026-08-02T00:00:00.000Z', file);
  assert.deepEqual(r.ids, ['b']); // only the Aug 2 row
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].sessionId, 'b');
});

test('readMachineSessions: missing file returns empty, no throw', () => {
  const r = mod.readMachineSessions(null, join(dir, 'does-not-exist.jsonl'));
  assert.deepEqual(r, { ids: [], sessions: [] });
});

test('readMachineSessions: rows without session_id are skipped (nothing to attribute)', () => {
  writeFileSync(file, [
    '{"job":"session-close","ts":"2026-08-03T06:00:00Z","usage":{"input_tokens":1}}',
    '{"session_id":"c","job":"spend-advice","ts":"2026-08-03T07:00:00Z","usage":{}}',
  ].join('\n'));
  const r = mod.readMachineSessions(null, file);
  assert.deepEqual(r.ids, ['c']);
  assert.equal(r.sessions[0].job, 'spend-advice');
  // Missing usage/model degrade gracefully.
  assert.equal(r.sessions[0].model, null);
  assert.deepEqual(r.sessions[0].usage, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});
