// Explore's rollup and a message with no timestamp (#334, audit miss on #304).
//
// The message range is `AND m.ts >= ?` under a bounded range and nothing at all
// under All (server/scope.ts), so under All an untimestamped row (a transcript
// line with no `timestamp`, which shared/types.ts allows and server/db.ts
// writes through) reaches the rollup's GROUP BY. Its bucket key is SQL NULL,
// which keys and labels a bucket "null" on the time chart. A query keyed by a
// timestamp needs scope.ts's tsNotNull on top of the range, the way the
// activity query in server/routes/projects.ts already does.
//
// Counting the undated message under All stays the rule
// (test/message-range-null-ts.test.mjs owns it, unchanged). It just gets no
// bucket of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

const MODEL = 'claude-sonnet-5';
const iso = (ms) => new Date(ms).toISOString();
const ROLLUPS = ['daily', 'weekly', 'monthly', 'hourly'];

let teardown, explore;

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession, db } = temp.dbModule;
  const p = upsertProject('/tmp/null-ts-rollup');

  // 12 timestamped events over 22 minutes, the rhythm the rest of the Explore
  // suite uses, so the session clears both noise-gate thresholds and the 'all'
  // scope's minor gate keeps it.
  const start = Date.now() - 3600000;
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push(i % 2 === 0
      ? { kind: 'tool_use', tool_name: 'Bash', tool_input: '{"command":"ls"}', tool_use_id: `t${i}`, ts: iso(start + i * 120000) }
      : { kind: 'assistant', model: MODEL, text: `assistant reply ${i} with enough text to attribute`,
          input_tokens: 100, output_tokens: 20, is_sidechain: 1, agent_type: 'Explore', ts: iso(start + i * 120000) });
  }
  replaceSession(
    { id: 'sNullTsRollup', project_id: p.id, source: 'claude-code', file_path: '/tmp/sNullTsRollup.jsonl',
      started_at: iso(start), ended_at: iso(start + 11 * 120000),
      usage: JSON.stringify({ [MODEL]: { input: 1200, output: 240, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    events,
  );

  // The undated rows. replaceSession's event path always stamps a ts, so these
  // go in directly, in the shape a transcript line with no `timestamp` lands
  // in. One per column the rollup's bucket scans read: a tool_use for the
  // tool/mcp groups, the failing tool_result answering it for the errors query,
  // and a sidechain assistant turn carrying per-message tokens for the
  // hour/subagent groups.
  const maxSeq = db.prepare("SELECT MAX(seq) AS s FROM messages WHERE session_id = 'sNullTsRollup'").get().s;
  db.prepare(`INSERT INTO messages (session_id, seq, ts, kind, tool_name, tool_input, tool_use_id)
              VALUES ('sNullTsRollup', ?, NULL, 'tool_use', 'Grep', '{"pattern":"needle"}', 'nts1')`).run(maxSeq + 1);
  db.prepare(`INSERT INTO messages (session_id, seq, ts, kind, tool_use_id, text)
              VALUES ('sNullTsRollup', ?, NULL, 'tool_result', 'nts1', 'Error: no such file')`).run(maxSeq + 2);
  db.prepare(`INSERT INTO messages (session_id, seq, ts, kind, model, text, input_tokens, output_tokens, is_sidechain, agent_type)
              VALUES ('sNullTsRollup', ?, NULL, 'assistant', ?, 'an undated sidechain turn, long enough to carry a char share', 90, 30, 1, 'Explore')`)
    .run(maxSeq + 3, MODEL);
});

after(() => teardown?.());

// Every bucket key the four rollups emit is a real local-time key:
// "YYYY-MM-DDTHH", "YYYY-MM-DD" or "YYYY-MM" (server/explore.ts bucketExpr).
// A NULL timestamp keys none of the three, so this is what "no null bucket"
// means, whether it arrives as SQL NULL or as the string "null".
const KEY_RE = /^\d{4}-\d{2}(-\d{2}(T\d{2})?)?$/;

const assertNoNullBucket = (result, where) => {
  for (const b of result.buckets ?? []) {
    assert.ok(b.bucket != null && KEY_RE.test(String(b.bucket)),
      `${where}: bucket key ${JSON.stringify(b.bucket)} (label ${JSON.stringify(b.label)}) is not a time bucket`);
  }
};

const run = (over) => explore.computeExplore({ scope: { type: 'all' }, range: rangeOf(null), topN: 10, ...over });

test('All range: an untimestamped message keys no bucket, at every granularity', () => {
  for (const rollup of ROLLUPS) {
    assertNoNullBucket(run({ metric: 'requests', group: 'tool', rollup }), `requests/tool/${rollup}`);
  }
});

// metric='errors' with a message-level group reads the erroring tool_result's
// own `r.ts`, a second bucket expression in the same rollup, so it needs the
// same guard: an undated failing tool_result is as undated as the tool_use it
// answers.
test('All range: an undated erroring tool_result keys no bucket either', () => {
  for (const rollup of ROLLUPS) {
    assertNoNullBucket(run({ metric: 'errors', group: 'tool', rollup }), `errors/tool/${rollup}`);
  }
});

// One combo per path the rollup has for keying a bucket off a message
// timestamp: exact (sessions.usage), calibrated (char share), per-message token
// columns, the two counting metrics, the two error paths, and active time.
test('All range: no null bucket on any metric x group path', () => {
  const combos = [
    ['tokens', 'model'], ['tokens', 'tool'], ['tokens', 'subagent'], ['tokens', 'project'],
    ['spend', 'tool'], ['requests', 'model'], ['sessions', 'source'],
    ['errors', 'project'], ['active', 'project'],
  ];
  for (const [metric, group] of combos) {
    for (const rollup of ROLLUPS) {
      assertNoNullBucket(run({ metric, group, rollup }), `${metric}/${group}/${rollup}`);
    }
  }
});

// The guard is about bucketing, not about counting.
test('the undated message still counts in the ranked rows under All', () => {
  const q = { metric: 'requests', group: 'tool' };
  const total = run({ ...q, rollup: 'total' });
  const daily = run({ ...q, rollup: 'daily' });
  assert.equal(total.rows.find((r) => r.key === 'Grep')?.requests, 1);
  assert.equal(daily.rows.find((r) => r.key === 'Grep')?.requests, 1);
  // And the timestamped rows still bucket exactly as they did: 6 Bash tool_use
  // rows in the fixture, and the daily chart carries every one of them.
  const bashInBuckets = (daily.buckets ?? []).reduce((n, b) => n + (b.series.Bash?.requests ?? 0), 0);
  assert.equal(bashInBuckets, 6);
});
