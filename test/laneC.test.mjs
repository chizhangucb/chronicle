import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let laneC, dir, file;

before(async () => {
  laneC = await import('../server/laneC.ts');
  dir = mkdtempSync(join(tmpdir(), 'lanec-'));
  file = join(dir, 'spend.jsonl');
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('readLaneCSpend: aggregates by model, tolerant of drift + blank lines', () => {
  writeFileSync(file, [
    '{"startTime":"2026-08-09T06:36:41Z","model":"openrouter/z-ai/glm-5.2","total_tokens":24,"spend":0.01}',
    '',
    '{"startTime":"2026-08-09T07:01:21Z","model":"openrouter/z-ai/glm-5.2","total_tokens":19,"spend":0.02}',
    // schema drift: extra fields (provider/latency_ms) must be ignored, not break parsing
    '{"startTime":"2026-08-12T01:29:51Z","model":"gpt-5.1","total_tokens":29,"spend":0.05,"provider":"Fireworks","latency_ms":1804}',
    'not json at all',
  ].join('\n'));
  const r = laneC.readLaneCSpend(null, file);
  assert.equal(r.requests, 3); // the 3 valid rows; blank + bad line skipped
  assert.ok(Math.abs(r.totalSpend - 0.08) < 1e-9);
  assert.equal(r.byModel.length, 2);
  // sorted by spend desc → gpt-5.1 ($0.05) first, glm ($0.03) second
  assert.equal(r.byModel[0].model, 'gpt-5.1');
  assert.equal(r.byModel[0].requests, 1);
  assert.equal(r.byModel[1].model, 'openrouter/z-ai/glm-5.2');
  assert.equal(r.byModel[1].requests, 2);
  assert.ok(Math.abs(r.byModel[1].spend - 0.03) < 1e-9);
  assert.equal(r.byModel[1].tokens, 43); // 24 + 19
});

test('readLaneCSpend: cutoff filters by startTime', () => {
  const r = laneC.readLaneCSpend('2026-08-10T00:00:00.000Z', file);
  assert.equal(r.requests, 1); // only the Aug 12 gpt-5.1 row
  assert.equal(r.byModel.length, 1);
  assert.equal(r.byModel[0].model, 'gpt-5.1');
});

test('readLaneCSpend: missing file returns empty, no throw', () => {
  const r = laneC.readLaneCSpend(null, join(dir, 'does-not-exist.jsonl'));
  assert.deepEqual(r, { totalSpend: 0, requests: 0, byModel: [] });
});

test('readLaneCSpend: missing spend/model fields degrade gracefully', () => {
  writeFileSync(file, '{"startTime":"2026-08-09T06:36:41Z","total_tokens":10}\n');
  const r = laneC.readLaneCSpend(null, file);
  assert.equal(r.requests, 1);
  assert.equal(r.totalSpend, 0);
  assert.equal(r.byModel[0].model, 'unknown'); // model missing → 'unknown'
  assert.equal(r.byModel[0].tokens, 10);
});
