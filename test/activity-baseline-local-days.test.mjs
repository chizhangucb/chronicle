// Regression pin (ticket #304): activity's "above your usual" baseline medians
// over LOCAL calendar days, like every other bucket in Chronicle. It used to
// bucket by UTC day — `substr(started_at,1,10)` against UTC midnights — so a
// session that ran on a local evening west of UTC was medianed into the wrong
// day, or (as here) pushed past the window's upper bound and dropped entirely.
//
// The fixture is built so the two spellings disagree by construction: the
// baseline is a median over 14 complete days, seven of which carry 1000
// tokens. The eighth day's session ran at 23:00 LOCAL on the day before today
// — which is already TODAY in UTC. UTC day math drops it (leaving 7 loaded
// days and 7 empty ones → median 500); local day math keeps it on yesterday
// (8 loaded days → median 1000).
process.env.TZ = 'America/Los_Angeles'; // UTC-7 in June: a local evening is the next UTC day
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

const MODEL = 'claude-sonnet-5';
const HOUR = 3600000;
// Local noon on 2026-06-15 (PDT, no DST edge within the 14-day window).
const NOW = Date.parse('2026-06-15T19:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// 12 assistant turns 2 minutes apart, so the session clears the noise gate.
const turns = (startMs, tokens) => Array.from({ length: 12 }, (_, i) => ({
  kind: 'assistant', model: MODEL, ts: iso(startMs + i * 120000),
  input_tokens: Math.round(tokens / 12), output_tokens: 0,
}));

let teardown, activity;

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  activity = await import('../server/activity.ts');
  const { upsertProject, replaceSession } = temp.dbModule;
  const p = upsertProject('/tmp/baseline-tz');

  const day = (start, id, tokens) => replaceSession(
    { id, project_id: p.id, source: 'claude-code', file_path: `/tmp/${id}.jsonl`,
      started_at: iso(start), ended_at: iso(start + 22 * 60000),
      usage: JSON.stringify({ [MODEL]: { input: tokens, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    turns(start, tokens),
  );

  // Seven loaded days, each at local noon (unambiguous under either spelling):
  // 2026-06-08 .. 2026-06-14 minus the boundary day, i.e. days 7..2 back plus day 8.
  for (const back of [8, 7, 6, 5, 4, 3, 2]) {
    day(NOW - back * 24 * HOUR, `d${back}`, 1000);
  }
  // The boundary session: 23:00 LOCAL on 2026-06-14 = 06:00 UTC on 2026-06-15,
  // i.e. already "today" in UTC but still yesterday locally.
  day(Date.parse('2026-06-15T06:00:00.000Z'), 'boundary', 1000);
});

after(async () => { teardown?.(); });

const total = (byModel) => Object.values(byModel).reduce(
  (n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h, 0);

test('the Today baseline medians LOCAL days: a 23:00-local session counts on its local day, not the next UTC one', () => {
  const r = activity.computeActivity({ type: 'all' }, rangeOf(1, NOW));
  // 8 loaded local days of 1000 + 6 empty ones → median of the 7th and 8th
  // sorted values = 1000. Under UTC day math the boundary session falls
  // outside the window, leaving 7 and 7 → median 500.
  assert.equal(total(r.burn.baselineTokensByModel), 1000);
});

test('the Today baseline is priced per model, not collapsed', () => {
  const r = activity.computeActivity({ type: 'all' }, rangeOf(1, NOW));
  assert.deepEqual(Object.keys(r.burn.baselineTokensByModel), [MODEL]);
  assert.equal(r.burn.baselineTokensByModel[MODEL].input, 1000);
});

test("the Today anchor is the operator's local day, not the UTC one", () => {
  const r = activity.computeActivity({ type: 'all' }, rangeOf(1, NOW));
  assert.equal(r.burn.today, '2026-06-15');
});
