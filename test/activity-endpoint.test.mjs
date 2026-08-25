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

// Assistant-only events (no human 'user' turns, so every inter-message gap counts toward
// agent_active_ms — see server/durations.ts) at explicit absolute timestamps, spaced days
// apart. Used for the spanning-session fixture below, whose messages straddle a window
// cutoff many days out — rhythmEvents' fixed 2-min spacing can't reach that far.
function spanEvents(timestampsMs, model, tokensPerMsg) {
  return timestampsMs.map((ms, i) => ({
    kind: 'assistant', model, ts: iso(ms), input_tokens: tokensPerMsg, output_tokens: 0, text: `span msg ${i}`,
  }));
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
  // started_at is CLAMPED to today's UTC midnight: when the suite runs shortly
  // after UTC midnight, "30/40 min ago" is still the PREVIOUS UTC calendar day,
  // and medianBaseline groups the 14 complete days by substr(started_at,1,10) —
  // so an un-clamped start would spill these today-sessions into yesterday's
  // baseline bucket and shift the median (a real midnight-boundary flake).
  // Liveness/recency are by ended_at (kept at now-2m/now-9m), so this clamp
  // changes nothing except near midnight. It's a no-op the rest of the day.
  const liveStart = Math.max(now - 30 * 60000, todayMidnight);
  const leftStart = Math.max(now - 40 * 60000, todayMidnight);
  // s_live: ended 2 min ago → LIVE (within the 5-min window).
  replaceSession(
    { id: 's_live', project_id: p.id, source: 'claude-code', file_path: '/tmp/s_live.jsonl',
      started_at: iso(liveStart), ended_at: iso(now - 2 * 60000), usage: usageJson(1000) },
    rhythmEvents(liveStart, MODEL),
  );
  // s_left: ended 9 min ago → NOT live; the "since you left" row. Carries one
  // erroring tool_result so errorCount plumbing is exercised.
  replaceSession(
    { id: 's_left', project_id: p.id, source: 'claude-code', file_path: '/tmp/s_left.jsonl',
      started_at: iso(leftStart), ended_at: iso(now - 9 * 60000), usage: usageJson(5000) },
    rhythmEvents(leftStart, MODEL, [
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

  // --- P0 regression fixture (feedback-round Task 2 review finding): a session whose
  // started_at predates a window cutoff but whose ended_at (and some messages) fall
  // INSIDE it — the burn tile's windowSpendTokensByModel must include its in-window
  // share, not exclude it entirely (old bug) or count its FULL usage (would defeat the
  // point of scaling). Deliberately anchored at days=10 (started 15d ago, ended 8d ago,
  // messages straddling the 10-day cutoff at ~9.5d ago) — a window strictly BETWEEN the
  // "Today" and "7d" windows the other tests pin exact totals for, so this fixture
  // contributes ZERO to those (both its started_at and ended_at sit outside every
  // window <=7d, and outside medianBaseline's/prior-7d's <=14d-back range on the near
  // side) and doesn't perturb any existing assertion in this file.
  const spannerBefore = [14, 13.5, 13, 12.5, 12, 11].map((d) => now - d * DAY); // before the 10d cutoff
  const spannerAfter = [9.5, 9, 8.8, 8.6, 8.4, 8.2].map((d) => now - d * DAY);  // after the 10d cutoff, before ended_at
  replaceSession(
    { id: 'spanner10d', project_id: p.id, source: 'claude-code', file_path: '/tmp/spanner10d.jsonl',
      started_at: iso(now - 15 * DAY), ended_at: iso(now - 8 * DAY),
      usage: usageJson(4000) },
    spanEvents([...spannerBefore, ...spannerAfter], MODEL, 10),
  );

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

test('burn window spend (10d, P0 regression): a session that started before the cutoff but ended inside it contributes its in-window share, not zero and not its full usage', async () => {
  const r = await getActivity({ days: 10, since: iso(now - 30 * 60000) });
  // The 10d window also picks up the other fixture sessions that overlap it: s_live(1000)
  // + s_left(5000) + d1..d6,d8,d9 (d7/d11-14 fall outside — see the daily-fixture comment
  // above) = (1+2+3+4+5+6+8+9)*1000 = 38000 + 6000 = 44000, UNAMBIGUOUSLY (comfortable
  // margin either side of the 10-day cutoff, like every other day used elsewhere in this
  // file). d10 is the one exception: it's excluded from that fixed sum and handled
  // dynamically below.
  //
  // TIME-OF-DAY FLAKE (review finding, feedback-round round 2): `dayAt(d)` anchors the
  // daily fixtures to UTC MIDNIGHT (`todayMidnight - d*DAY + 12h`, needed for the
  // calendar-day median-baseline bucketing other tests in this file rely on), while the
  // production `days:10` cutoff used by the route under test is a ROLLING window anchored
  // to real `Date.now()` (`now - 10*DAY` — server/activity.ts computeActivity). These two
  // anchors diverge by up to ±12h depending on wall-clock time-of-day. Every OTHER day
  // offset used in this file (d1..d9, d11..d14) has enough margin from its own window
  // boundary that the ±12h drift never flips its inclusion — d10 is the only one placed
  // EXACTLY on the days:10 boundary, so whether it's in or out of the window is genuinely
  // ambiguous at the instant this test runs (confirmed live: this assertion read 46000 at
  // 12:31 UTC and would read 56000 before ~12:00 UTC, a deterministic — not random —
  // divergence tied to time-of-day, not flakiness in the underlying overlapGate logic).
  //
  // Fix: mirror the EXACT production comparison (server/windowUsage.ts `overlapGate`:
  // `COALESCE(ended_at, started_at, '9') >= cutoff`) to decide d10's inclusion dynamically,
  // instead of hardcoding a snapshot that only holds on one side of UTC noon. d10's own
  // session is a tight 22-minute span (see rhythmEvents above), so unlike spanner10d it is
  // essentially always all-in or all-out, never partially scaled — except in the residual
  // ~22-minutes-out-of-24-hours edge where the cutoff itself lands inside that span, which
  // is accepted here as the same class of low-probability risk already accepted elsewhere
  // in this codebase (e.g. helpers.ts's "first 35 minutes after local midnight" comment).
  const d10EndedAtMs = dayAt(10) + 22 * 60000;
  const cutoff10Ms = now - 10 * DAY;
  const d10Included = d10EndedAtMs >= cutoff10Ms;
  const baselineExcludingSpanner = 44000 + (d10Included ? 10000 : 0);
  // spanner10d: billed input=4000; 12 messages @10 tokens each (120 total), 6 before the
  // 10d cutoff and 6 after → in-window ratio 6/12 = 0.5 → windowed cell = 2000 (this split
  // is itself anchored to real `now`, same as the route's cutoff, so it's never ambiguous).
  // PER-BUCKET ROUNDING DRIFT (second time-of-day flake in this assertion, found when
  // it failed 55999 !== 56000 on the v1.3.0 publish run). The route aggregates
  // `bucketedUsage`, not `windowedUsage`, and bucketedUsage rounds EACH local-day bucket
  // independently — server/windowUsage.ts says so outright: summing a session-model's
  // bucketed cells "reproduces windowedUsage's own scaled cell for that session-model (up
  // to per-bucket rounding drift)".
  //
  // spanner10d's six in-window messages sit at 9.5/9/8.8/8.6/8.4/8.2 days ago, so they
  // straddle two or three LOCAL calendar days depending on what time of day the suite
  // runs. Split 2+2+2 the rounded parts sum to exactly 2000; split 1+1+2+2 (or similar)
  // they sum to 1999, because round(4000 * 10/120) = 333 loses a third of a token each
  // time. Nothing is wrong when that happens — it is the documented cost of bucketing.
  //
  // So allow a few tokens of drift instead of demanding an exact total. The tolerance is
  // deliberately tiny relative to what this test actually guards: the P0 regressions below
  // are off by 2000 or 4000 tokens, three orders of magnitude outside this band.
  const total = tok(r.burn.windowSpendTokensByModel);
  const expected = baselineExcludingSpanner + 2000;
  const ROUNDING_DRIFT = 5; // < 1 token per local-day bucket spanner10d can occupy
  assert.ok(
    Math.abs(total - expected) <= ROUNDING_DRIFT,
    `must equal baseline(${baselineExcludingSpanner}, d10Included=${d10Included}) + spanner10d's `
    + `scaled in-window share(2000) = ${expected}, within ${ROUNDING_DRIFT} tokens of per-bucket `
    + `rounding drift — got ${total} (off by ${total - expected})`,
  );
  assert.ok(total > baselineExcludingSpanner, 'spanner10d must not be dropped entirely (the P0 bug: old gate excluded it)');
  assert.ok(total < baselineExcludingSpanner + 4000, 'spanner10d must not be counted at its FULL billed usage (must be scaled to its in-window share)');
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
