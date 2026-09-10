// Explore's error counts for the groups that attribute an error to something INSIDE
// the session (tool/skill/model/subagent/mcp/provider). Those read the head query and
// name the group value off the erroring tool_result's PAIRED tool_use, and that pairing
// is gated only by the RESULT's ts, so a call made before the range whose result landed
// inside it names a group value the ranked rows never built a line for. The rows drop
// it; the rollup must drop it too, or the stacked chart out-totals the table (#330, the
// same reconciliation rule as the session-level branch in test/explore-errors.test.mjs).
//
// Own temp DB, so this file's span fixture cannot perturb the other explore suites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore;

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Two days back: inside a 7-day range, and far enough from both edges that the daily
// buckets do not depend on the hour this suite runs at.
const IN_RANGE = now - 2 * DAY;
// Ten days back: outside a 7-day range, but the session it belongs to ran on into it.
const BEFORE_RANGE = now - 10 * DAY;

// 12 alternating user/assistant messages over 22 minutes, so the session clears both
// noise-gate thresholds and is not excluded by minorGate. Same shape as the other
// explore suites' rhythm fixtures.
function rhythmEvents(baseMs, extra = []) {
  const events = Array.from({ length: 12 }, (_, i) => ({
    kind: i % 2 === 0 ? 'user' : 'assistant',
    text: `msg ${i}`,
    ts: iso(baseMs + i * 2 * 60000),
    ...(i % 2 === 1 ? { model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50 } : {}),
  }));
  return [...events, ...extra];
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const proj = upsertProject('/tmp/proj-explore-errors-attributed');

  // One session spanning the range edge, carrying two erroring tool calls:
  //   Grep — called BEFORE the range, its error came back INSIDE it. Under a 7-day
  //          range no in-range tool_use names Grep, so the ranked rows hold no Grep
  //          line at all, and the chart must not draw one either.
  //   Bash — called and errored wholly inside the range. The rows do hold this one, so
  //          it is what both the table and the chart are supposed to show.
  replaceSession(
    { id: 'seSpan', project_id: proj.id, source: 'claude-code', file_path: '/tmp/seSpan.jsonl',
      started_at: iso(BEFORE_RANGE), ended_at: iso(now - 1 * DAY) },
    rhythmEvents(BEFORE_RANGE, [
      { kind: 'tool_use', tool_name: 'Grep', tool_use_id: 'sp-grep', ts: iso(BEFORE_RANGE + 3600000) },
      { kind: 'tool_result', tool_use_id: 'sp-grep', text: 'Error: boom', ts: iso(IN_RANGE) },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'sp-bash', ts: iso(IN_RANGE + 60000) },
      { kind: 'tool_result', tool_use_id: 'sp-bash', text: 'Error: boom', ts: iso(IN_RANGE + 61000) },
    ]),
  );
});
after(() => teardown());

// The two numbers a reconciliation assertion compares: the Detail table's total bar,
// and the stacked chart beside it.
function errorTotals(r) {
  return {
    rowTotal: r.rows.reduce((n, row) => n + row.errors, 0),
    bucketTotal: (r.buckets ?? []).reduce(
      (n, b) => n + Object.values(b.series).reduce((m, cell) => m + cell.errors, 0), 0),
  };
}

const q = { scope: { type: 'all' }, metric: 'errors', group: 'tool', rollup: 'daily', topN: 10 };

// The control: with no range, both calls are in scope and both surfaces show both.
test('group=tool over all time: every attributed error reaches both the rows and the chart', () => {
  const r = explore.computeExplore({ ...q, days: null });
  const { rowTotal, bucketTotal } = errorTotals(r);
  assert.equal(r.rows.find((x) => x.key === 'Grep')?.errors, 1);
  assert.equal(r.rows.find((x) => x.key === 'Bash')?.errors, 1);
  assert.equal(rowTotal, 2);
  assert.equal(bucketTotal, rowTotal, 'stacked chart must equal the total bar');
});

test('group=tool under a range: a call made before the range cannot draw a bar of its own', () => {
  const r = explore.computeExplore({ ...q, days: 7 });
  const { rowTotal, bucketTotal } = errorTotals(r);
  assert.ok(r.rows.length > 0, 'the range holds tool calls, so the rows cannot be empty');
  assert.ok((r.buckets ?? []).length > 0, 'the range holds an error, so the chart cannot be empty');
  assert.equal(r.rows.find((x) => x.key === 'Grep'), undefined,
    'no in-range tool_use names Grep, so the table has no Grep line');
  assert.equal(rowTotal, 1, 'only the wholly in-range Bash call errored inside the range');
  assert.equal(bucketTotal, rowTotal, 'stacked chart must equal the total bar');
  const grepBars = (r.buckets ?? []).reduce((n, b) => n + (b.series.Grep?.errors ?? 0), 0);
  assert.equal(grepBars, 0, 'the chart may not stack a series the table has no line for');
});
