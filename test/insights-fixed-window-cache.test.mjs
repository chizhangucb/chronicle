// Ticket #274: the Insights engine's fixed-window aggregates
// (dailyActivity/hourlyActivity/modelDistFixed) are cached through
// server/cache.ts instead of a private TTL map in server/insights.ts.
//
// Two properties, one per test. The aggregates are still CACHED, so a second
// request for the same scope and cutoffs does not re-run the three queries.
// And the shared cache is GENERATION-keyed, so a session landing in the
// database makes that cache entry stale at once: the private map was
// expiry-only, so a fresh import stayed invisible on the calendar and the hour
// grid for the whole 20s window even though the range control was re-fetching.
// Every call below passes the SAME `range`, which is what makes the key
// identical across them (the cutoffs are quantized to the minute), and that is
// the case the private cache got wrong.
//
// Same shared-temp-db-for-the-whole-file pattern as test/insights.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

let dbModule, teardown, insightsModule;

// Two days back, so both sessions sit well inside the 182-day calendar window
// and the 30-day hour grid whatever the wall clock says.
const BASE = new Date(Date.now() - 2 * 86400000);
BASE.setUTCHours(10, 0, 0, 0);

// 12 messages, 2 minutes apart: comfortably clear of the noise gate's 5-min /
// 10-message minor thresholds, so the session is visible to every aggregate.
function rhythmEvents(startMs) {
  return Array.from({ length: 12 }, (_, i) => ({
    kind: i % 2 === 0 ? 'user' : 'assistant',
    text: `msg ${i}`,
    ts: new Date(startMs + i * 2 * 60000).toISOString(),
    ...(i % 2 === 1 ? { model: 'claude-sonnet-5' } : {}),
  }));
}

function addSession(id, projectId, startMs) {
  dbModule.replaceSession(
    {
      id, project_id: projectId, source: 'claude-code', file_path: `/tmp/${id}.jsonl`,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(startMs + 22 * 60000).toISOString(),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    rhythmEvents(startMs),
  );
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  insightsModule = await import('../server/insights.ts');
  addSession('f1', dbModule.upsertProject('/tmp/fixed-a').id, BASE.getTime());
});

after(() => teardown());

const totalMessages = (dailyActivity) => dailyActivity.reduce((sum, d) => sum + d.count, 0);

// The write goes straight to the table, NOT through replaceSession, so no
// invalidation fires: an uncached engine would report the extra message and a
// cached one cannot. That is the only way to see the cache hit from outside.
test('the fixed windows are cached: a write nothing invalidated is not picked up', async () => {
  const range = rangeOf(7);
  const first = await insightsModule.computeInsights({ type: 'all' }, range);
  dbModule.getDb().prepare(
    'INSERT INTO messages (session_id, seq, ts, kind, text) VALUES (?, ?, ?, ?, ?)',
  ).run('f1', 999, new Date(BASE.getTime()).toISOString(), 'user', 'uninvalidated');
  const second = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(totalMessages(second.dailyActivity), totalMessages(first.dailyActivity),
    'the fixed windows re-ran their queries instead of reading the cache');
  assert.deepEqual(second.hourlyActivity, first.hourlyActivity);
  // Taken back out the same way it went in, so the next test starts from the
  // row count the fixtures set up.
  dbModule.getDb().prepare('DELETE FROM messages WHERE seq = 999').run();
});

test('an import makes the fixed windows stale at once, not when a TTL runs out', async () => {
  const range = rangeOf(7);
  const before_ = await insightsModule.computeInsights({ type: 'all' }, range);
  addSession('f2', dbModule.upsertProject('/tmp/fixed-b').id, BASE.getTime() + 86400000);
  const after_ = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(totalMessages(after_.dailyActivity), totalMessages(before_.dailyActivity) + 12,
    'the newly imported session is still missing from the calendar');
});
