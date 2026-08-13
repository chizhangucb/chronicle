// Task 13 (New home dashboard): GET /api/activity backs the Home dashboard's
// Activity block (live + since-you-left rows) and Burn tile (current window
// spend vs a baseline). Like search-recent.test.mjs, the logic lives in an
// Express route handler, so this mounts the real route on an ephemeral server
// and drives it over HTTP — exercising query-param parsing (`since`/`days`),
// the response shape, live-flag detection, and the burn math end to end.
//
// fixture-vs-now: 'Today'/live/window math is relative to Date.now(), while the
// static fixtures are frozen in the past — so every timestamp below is seeded
// RELATIVE to now (per the task brief). The DB is seeded directly (not via the
// parser) so the timestamps are exactly what the burn/live math sees.
//
// Minor gate: replaceSession gates any session with agent_active_ms < 5min AND
// < 10 messages into minor=1 (invisible to aggregates) — so each fixture
// session uses a 12-message rhythm (mirrors insights.test.mjs) to stay visible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withTempDb } from './helpers.mjs';

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// UTC midnight of "today" — the burn MEDIAN baseline groups by UTC calendar
// day (substr(ts,1,10)), so the trailing complete days are anchored here.
const nowDate = new Date(now);
const todayMidnight = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
// Noon on the calendar day `d` days ago (safely inside that UTC day).
const dayAt = (d) => todayMidnight - d * DAY + 12 * 3600000;

let dbModule, teardown, server, baseUrl;

function rhythmEvents(baseMs, model, extra = []) {
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: iso(baseMs + i * 2 * 60000),
      ...(i % 2 === 1 ? { model } : {}),
    });
  }
  return [...events, ...extra];
}

const MODEL = 'claude-sonnet-5';
function usageJson(input) {
  return JSON.stringify({ [MODEL]: { input, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  const { upsertProject, replaceSession } = dbModule;
  const { mountActivity } = await import('../server/routes/activity.ts');

  const p = upsertProject('/tmp/proj-activity');

  // --- Today's sessions (window = fractional "today"; membership is by
  // absolute started_at >= cutoff, so timing them relative to now is stable). ---
  // s_live: ended 2 min ago → LIVE (within the 5-min window).
  replaceSession(
    { id: 's_live', project_id: p.id, source: 'claude-code', file_path: '/tmp/s_live.jsonl',
      started_at: iso(now - 30 * 60000), ended_at: iso(now - 2 * 60000), usage: usageJson(1000) },
    rhythmEvents(now - 30 * 60000, MODEL),
  );
  // s_left: ended 9 min ago → NOT live; the "since you left" row. Carries one
  // erroring tool_result so errorCount plumbing is exercised.
  replaceSession(
    { id: 's_left', project_id: p.id, source: 'claude-code', file_path: '/tmp/s_left.jsonl',
      started_at: iso(now - 40 * 60000), ended_at: iso(now - 9 * 60000), usage: usageJson(5000) },
    rhythmEvents(now - 40 * 60000, MODEL, [
      { kind: 'tool_use', tool_name: 'Bash', ts: iso(now - 10 * 60000) },
      { kind: 'tool_result', text: 'Error: boom', ts: iso(now - 10 * 60000 + 5000) },
    ]),
  );

  // --- Trailing complete days for the median baseline (d = calendar days ago).
  // Seed d=1..6 and d=8..13 (skip 7 and 14 to keep the 7d-window boundaries
  // deterministic); input = d*1000. Daily totals over d=1..14 (7 and 14 = 0):
  //   [1,2,3,4,5,6,0,8,9,10,11,12,13,0]*1000 → median = avg(5000,6000) = 5500.
  // Also: d=1..6 fall in the current-7d window; d=8..13 fall in the prior-7d
  // (baseline) window.
  for (const d of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
    const base = dayAt(d);
    replaceSession(
      { id: `d${d}`, project_id: p.id, source: 'claude-code', file_path: `/tmp/d${d}.jsonl`,
        started_at: iso(base), ended_at: iso(base + 22 * 60000), usage: usageJson(d * 1000) },
      rhythmEvents(base, MODEL),
    );
  }

  const app = express();
  mountActivity(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
});

// "Today" is a fractional-day window (now → local/UTC midnight); express parses
// it off the query string, so pass the real value the client would send.
const todayDays = (now - todayMidnight) / DAY;

async function getActivity({ since, days } = {}) {
  const qs = new URLSearchParams();
  if (since != null) qs.set('since', since);
  if (days != null) qs.set('days', String(days));
  const res = await fetch(`${baseUrl}/activity?${qs.toString()}`);
  assert.equal(res.status, 200);
  return res.json();
}

function tok(byModel, model = MODEL) {
  return byModel[model]?.input ?? 0;
}

test('shape: returns live[], recent[], and a burn object', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  assert.ok(Array.isArray(r.live));
  assert.ok(Array.isArray(r.recent));
  assert.ok(r.burn && typeof r.burn === 'object');
  assert.ok(r.burn.windowSpendTokensByModel);
  assert.ok(r.burn.baselineTokensByModel);
  assert.ok('topSessionId' in r.burn);
  assert.ok('topSessionName' in r.burn);
});

test('live flag: s_live (ended 2m ago) is live; s_left (ended 9m ago) is not', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  const liveIds = r.live.map((s) => s.id);
  assert.ok(liveIds.includes('s_live'), 's_live should be live');
  assert.ok(!liveIds.includes('s_left'), 's_left should not be live');
  const live = r.live.find((s) => s.id === 's_live');
  assert.equal(live.live, true);
  // SessionLite carries per-session token cells (client prices them) + errorCount.
  assert.ok(live.tokensByModel);
  assert.equal(typeof live.errorCount, 'number');
});

test('recent (since-you-left): includes the not-live s_left, excludes the live one', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  const recentIds = r.recent.map((s) => s.id);
  assert.ok(recentIds.includes('s_left'), 's_left ended within `since` and is not live');
  assert.ok(!recentIds.includes('s_live'), 'the live session is not duplicated into recent');
  const left = r.recent.find((s) => s.id === 's_left');
  assert.equal(left.live, false);
  assert.equal(left.errorCount, 1, 's_left has one erroring tool_result');
  assert.equal(tok(left.tokensByModel), 5000);
});

test('recent respects `since`: a tight since window excludes older sessions', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  // The daily baseline sessions all ended hours ago — before `since` = 30m ago.
  assert.ok(!r.recent.some((s) => s.id.startsWith('d')), 'older daily sessions are outside the since window');
});

test('burn window spend (Today): sums today\'s window sessions per model', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  // s_live(1000) + s_left(5000) = 6000; daily sessions are before midnight → excluded.
  assert.equal(tok(r.burn.windowSpendTokensByModel), 6000);
});

test('burn baseline (Today): median of the trailing 14 complete days = 5500', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  assert.equal(tok(r.burn.baselineTokensByModel), 5500);
});

test('burn topSession (Today): the highest-token window session', async () => {
  const r = await getActivity({ days: todayDays, since: iso(now - 30 * 60000) });
  assert.equal(r.burn.topSessionId, 's_left'); // 5000 > 1000
  assert.ok(r.burn.topSessionName);
});

test('burn window spend + baseline (7d): current 7d vs prior 7d', async () => {
  const r = await getActivity({ days: 7, since: iso(now - 30 * 60000) });
  // current 7d = today(6000) + d1..d6 (21000) = 27000
  assert.equal(tok(r.burn.windowSpendTokensByModel), 27000);
  // prior 7d = d8..d13 = (8+9+10+11+12+13)*1000 = 63000
  assert.equal(tok(r.burn.baselineTokensByModel), 63000);
});

test('minor sessions are excluded from the window aggregates', async () => {
  const { db } = dbModule;
  // The route caches by URL and invalidates on DB writes (server/cache.ts) —
  // a raw UPDATE bypasses that, so invalidate explicitly (a real write path,
  // replaceSession, would). Otherwise the prior 7d query's cached result wins.
  const { invalidateCache } = await import('../server/cache.ts');
  db.prepare('UPDATE sessions SET minor = 1 WHERE id = ?').run('d1');
  invalidateCache();
  const r = await getActivity({ days: 7, since: iso(now - 30 * 60000) });
  // d1 (1000) drops out of the current-7d window → 27000 - 1000 = 26000
  assert.equal(tok(r.burn.windowSpendTokensByModel), 26000);
  db.prepare('UPDATE sessions SET minor = 0 WHERE id = ?').run('d1');
  invalidateCache();
});
