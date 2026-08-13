// Explore hourly rollup must always render at hourly granularity — no silent
// coarsening to daily when the requested window's bucket count exceeds the
// legibility cap (ROLLUP_BUCKET_CAP=90). Windowing a dense hourly series is
// the CLIENT's job (a Recharts <Brush> defaulting to the last 72 buckets),
// not the server's — see records/design/… spec §2.4 / task-10 brief.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore, otherProjectId;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const proj = upsertProject('/tmp/proj-hourly');

  // One message per hour for the last 168 hours (7 full days), all strictly
  // after `days=7`'s cutoff and strictly before "now" — so every hour lands
  // in its own distinct bucket and none is dropped at either edge. kind:
  // 'assistant' (not 'user') so isHumanPrompt() doesn't zero out every
  // inter-message gap — an all-human-prompt session computes agent_active_ms
  // = 0, which trips isMinorSession's 5-min floor and the minor-session
  // bucket gets excluded by minorGate for scope 'all', silently returning 0
  // buckets regardless of the rollup fix under test.
  //
  // 30-minute safety margin off the oldest edge: 168h is EXACTLY the
  // `days=7` cutoff, so the oldest event's `ts` (computed here, at fixture
  // build time) can land a few ms earlier than `cutoff` (computed later,
  // inside computeExplore() at assertion time) and get excluded by the
  // `started_at >= cutoff` filter — silently zeroing every row (a real bug
  // this test tripped over, not a hypothetical).
  const now = Date.now();
  const oldestMs = now - (167 * 3600000 + 30 * 60000); // 167.5h ago
  const events = [];
  for (let i = 0; i < 168; i++) {
    events.push({
      kind: 'assistant', text: `hourly msg ${i}`, model: 'claude-sonnet-5',
      input_tokens: 10, output_tokens: 5,
      ts: new Date(oldestMs + i * 3600000).toISOString(),
    });
  }
  replaceSession(
    { id: 'sHourly', project_id: proj.id, source: 'claude-code', file_path: '/tmp/sHourly.jsonl',
      started_at: new Date(oldestMs).toISOString(),
      ended_at: new Date(oldestMs + 167 * 3600000).toISOString() },
    events,
  );

  // ---- "Other" segment math fixture (Step 4) ----
  // days:null (no cutoff) below, so this can use fixed dates like the rest
  // of the explore test suite — no clock-drift bookkeeping needed here.
  // topN=3 over 7 distinct tools across 2 days: Bash/Grep/Read make top-3 by
  // RANGE total (Bash 5+2=7, Grep 1+6=7, Read 4+0=4); Write/Edit/Glob/WebFetch
  // fold into 'Other'. Chosen so day 1 and day 2 each mix top-3 and
  // folded-out tools, and neither day's Other total is zero — a bug that
  // zeroes Other in one bucket but not the other wouldn't be caught by a
  // fixture where only one day has overflow tools.
  const proj2 = upsertProject('/tmp/proj-other');
  otherProjectId = proj2.id;
  const toolEvents = (day, counts) => {
    const events2 = [];
    let cursor = new Date(`${day}T09:00:00.000Z`).getTime();
    for (const [tool, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        events2.push({ kind: 'tool_use', tool_name: tool, tool_use_id: `${day}-${tool}-${i}`, ts: new Date(cursor).toISOString() });
        cursor += 60000;
      }
    }
    return events2;
  };
  // Interleaved assistant turns (not all-human) so agent_active_ms clears
  // isMinorSession's floor — same reasoning as the hourly fixture above.
  const assistantEvents = (day) => Array.from({ length: 8 }, (_, i) => ({
    kind: 'assistant', text: `msg ${i}`, model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5,
    ts: new Date(new Date(`${day}T08:00:00.000Z`).getTime() + i * 120000).toISOString(),
  }));
  replaceSession(
    { id: 'sOther', project_id: proj2.id, source: 'claude-code', file_path: '/tmp/sOther.jsonl',
      started_at: '2026-08-01T08:00:00.000Z', ended_at: '2026-08-02T10:00:00.000Z' },
    [
      ...assistantEvents('2026-08-01'),
      ...toolEvents('2026-08-01', { Bash: 5, Read: 4, Write: 3, Edit: 2, Grep: 1 }),
      ...assistantEvents('2026-08-02'),
      ...toolEvents('2026-08-02', { Bash: 2, Grep: 6, Glob: 3, WebFetch: 1 }),
    ],
  );
});
after(() => teardown());

test('rollup=hourly, days=7 returns 168 hourly buckets — no silent daily coercion', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: 7, metric: 'requests', group: 'source', rollup: 'hourly', topN: 10,
  });
  assert.equal(r.requestedRollup, 'hourly');
  assert.equal(r.rollup, 'hourly'); // must NOT be coarsened to 'daily'
  assert.equal(r.buckets?.length, 168);
});

// Step 4 ("Other" segment): the brief's e2e probe choice — the shared fixture
// generator (test/fixtures/gen-big-session.mjs) writes ONE cwd, and extending
// it to 6 tiny cwds purely to exercise >5-project folding is invasive for a
// generator every other e2e spec also depends on. Per the brief's documented
// implementer's choice ("implementer picks and documents"), this verifies the
// Other-series MATH at the engine (data-builder) level instead: with more
// group values than topN, the per-bucket sum across every returned series
// (topN + Other) must reconcile to that bucket's true unstacked total, within
// 1%. The client's chartData builder (src/ExploreTab.tsx) is a straight
// re-projection of `result.buckets` onto Recharts rows (one cell per ranked
// series, defaulting missing cells to 0) — it does not re-aggregate, so this
// server-side reconciliation is what actually proves "the stacked bar height
// equals the unstacked total" the brief asks for; the >5-project VISUAL
// check (a real screenshot with 6 distinct series rendered) is deferred to
// the C4 real-data walk, which has this repo's own multi-project session data
// to draw on instead of a synthetic fixture.
test('rollup Other segment: per-bucket series sum (topN + Other) reconciles to the bucket total, within 1%', () => {
  const r = explore.computeExplore({
    scope: { type: 'project', id: otherProjectId }, days: null, metric: 'requests', group: 'tool', rollup: 'daily', topN: 3,
  });
  assert.equal(r.buckets?.length, 2);
  const otherRow = r.rows.find((x) => x.key === 'Other');
  assert.ok(otherRow, 'expected an Other row — 5 distinct tools over 3 topN');
  assert.equal(otherRow.otherCount, 4); // Write, Edit, Glob, WebFetch

  const dayTotals = { '2026-08-01': 5 + 4 + 3 + 2 + 1, '2026-08-02': 2 + 6 + 3 + 1 };
  for (const bucket of r.buckets ?? []) {
    const seriesSum = Object.values(bucket.series).reduce((n, cell) => n + cell.requests, 0);
    const trueTotal = dayTotals[bucket.bucket];
    assert.ok(trueTotal != null, `unexpected bucket key ${bucket.bucket}`);
    const pctDiff = Math.abs(seriesSum - trueTotal) / trueTotal;
    assert.ok(pctDiff <= 0.01, `bucket ${bucket.bucket}: series sum ${seriesSum} vs true total ${trueTotal} (${(pctDiff * 100).toFixed(1)}% off)`);
  }
  // And the Other cell itself is genuinely non-zero in BOTH buckets (not a
  // bug that only zeroes out the overflow on one side).
  const day1Other = r.buckets?.find((b) => b.bucket === '2026-08-01')?.series.Other?.requests ?? 0;
  const day2Other = r.buckets?.find((b) => b.bucket === '2026-08-02')?.series.Other?.requests ?? 0;
  assert.equal(day1Other, 3 + 2); // Write + Edit
  assert.equal(day2Other, 3 + 1); // Glob + WebFetch
});
