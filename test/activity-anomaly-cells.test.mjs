// CHI-324 2c: computeActivity emits per-day per-dimension token CELLS
// (burn.anomalyDays) so the client can price → CostedDay[] → the shared
// computeAnomaly. Server ships cells, not dollars. Also asserts burn.today and
// burn.laneCByDay are present.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, activity;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const localToday = (() => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

function rhythm(baseMs, model) {
  const ev = [];
  for (let i = 0; i < 12; i++) ev.push({ kind: i % 2 === 0 ? 'user' : 'assistant', text: `m${i}`, ts: iso(baseMs + i * 120000), ...(i % 2 ? { model } : {}) });
  return ev;
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  activity = await import('../server/activity.ts');
  const { upsertProject, replaceSession } = dbModule;
  const pa = upsertProject('/tmp/proj-a');
  const pb = upsertProject('/tmp/proj-b');
  const base = now - 3 * 3600000; // 3h ago → local "today"
  replaceSession(
    { id: 'sa', project_id: pa.id, source: 'claude-code', file_path: '/tmp/sa.jsonl',
      started_at: iso(base), ended_at: iso(base + 3600000),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythm(base, 'claude-sonnet-5'),
  );
  replaceSession(
    { id: 'sb', project_id: pb.id, source: 'codex', file_path: '/tmp/sb.jsonl',
      started_at: iso(base + 600000), ended_at: iso(base + 1200000),
      usage: JSON.stringify({ 'gpt-5.6-terra': { input: 400, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythm(base + 600000, 'gpt-5.6-terra'),
  );
});
after(async () => { await teardown?.(); });

test('burn carries today + laneCByDay + anomalyDays', () => {
  const r = activity.computeActivity(null, 1);
  assert.equal(r.burn.today, localToday);
  assert.ok(r.burn.laneCByDay && typeof r.burn.laneCByDay === 'object'); // empty is fine (no proxy log)
  assert.ok(Array.isArray(r.burn.anomalyDays) && r.burn.anomalyDays.length >= 1);
});

test("today's anomaly day cells split by project / model / source", () => {
  const r = activity.computeActivity(null, 1);
  const day = r.burn.anomalyDays.find((d) => d.day === localToday);
  assert.ok(day, 'today is present in anomalyDays');
  // Two projects, two models, two sources — each dimension keyed and populated.
  assert.deepEqual(Object.keys(day.byProject).sort(), ['proj-a', 'proj-b']);
  assert.deepEqual(Object.keys(day.byModel).sort(), ['claude-sonnet-5', 'gpt-5.6-terra']);
  assert.deepEqual(Object.keys(day.bySource).sort(), ['claude-code', 'codex']);
  // Cells are token magnitudes, not dollars.
  assert.ok(day.byModel['claude-sonnet-5'].input > 0);
});
