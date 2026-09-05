// server/activity.ts's burn.windowSpendTokensByModel (the CURRENT-
// window spend figure the Home Burn tile shows — the exact number the
// audit found overstated ~50% for Sonnet-5-heavy usage during the intro
// window) must carry a day-bucketed breakdown so the client can price a
// window that straddles the 2026-08-31 cutover correctly per day. Uses
// days:null (the "All" window) so the fixture is independent of Date.now() —
// baseline/topSession day-bucketing is a documented out-of-scope boundary
// (see server/activity.ts's comments): both are already statistical/proxy
// magnitudes (a 14-day median, a raw-token-ranked top session), not the live
// spend figure this fix targets, and the baseline's window math is anchored
// to Date.now() in a way that can't be pinned to a fixed calendar date
// without the test silently going stale once real time passes the cutover.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, activity;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  activity = await import('../server/activity.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/cutover-burn-proj');

  replaceSession(
    { id: 'pre', project_id: p.id, source: 'claude-code', file_path: '/tmp/pre.jsonl',
      started_at: '2026-08-15T10:00:00.000Z', ended_at: '2026-08-15T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-08-15T10:05:00.000Z', text: 'a' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-08-15T10:10:00.000Z', text: 'b' },
    ],
  );
  replaceSession(
    { id: 'post', project_id: p.id, source: 'claude-code', file_path: '/tmp/post.jsonl',
      started_at: '2026-09-01T10:00:00.000Z', ended_at: '2026-09-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-09-01T10:05:00.000Z', text: 'c' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 500_000, ts: '2026-09-01T10:10:00.000Z', text: 'd' },
    ],
  );
});

after(async () => { teardown?.(); });

test('computeActivity(days=null): burn.windowSpendTokensByModelByDay splits the All-window total by LOCAL day', () => {
  const r = activity.computeActivity(null, null);
  assert.ok(r.burn.windowSpendTokensByModelByDay, 'burn must carry windowSpendTokensByModelByDay');
  assert.equal(r.burn.windowSpendTokensByModelByDay['2026-08-15']['claude-sonnet-5'].input, 1_000_000);
  assert.equal(r.burn.windowSpendTokensByModelByDay['2026-09-01']['claude-sonnet-5'].input, 1_000_000);

  const byDaySum = Object.values(r.burn.windowSpendTokensByModelByDay)
    .reduce((n, byModel) => n + Object.values(byModel).reduce((m, c) => m + c.input + c.output, 0), 0);
  const flatTotal = Object.values(r.burn.windowSpendTokensByModel).reduce((n, c) => n + c.input + c.output, 0);
  assert.equal(byDaySum, flatTotal, 'day-bucketed sum must reconcile exactly with the flat total');
  assert.equal(flatTotal, 2_000_000);
});
