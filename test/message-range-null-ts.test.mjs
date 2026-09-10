// The message range and a message with no timestamp (review follow-up on #304).
//
// `queryContext(...).messages()` is `AND m.ts >= ?` under a bounded range and
// NOTHING under All. A message whose `ts` is NULL — a transcript line with no
// timestamp, which `shared/types.ts` allows and `server/db.ts` writes through
// — therefore falls out of every bounded range and in under All: no range
// means no time filter, so nothing is filtered on a column it has no value
// for.
//
// That is a deliberate change of direction. The pre-slice spelling bound the
// empty string as its "All" sentinel and still emitted `AND m.ts >= ''`, and
// `NULL >= ''` is NULL, so those rows were dropped from All too — an accident
// of the sentinel rather than a rule. Both directions are pinned here so the
// rule is a decision, not a side effect of whichever sentinel a call site
// happens to use.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

const MODEL = 'claude-sonnet-5';
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

let teardown, insights, content, explore;

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  insights = await import('../server/insights.ts');
  content = await import('../server/content.ts');
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession, db } = temp.dbModule;
  const p = upsertProject('/tmp/null-ts');

  // 12 timestamped assistant turns, 2 minutes apart, so the session clears
  // the noise gate and every aggregate below has a stable denominator.
  const start = now - 3600000;
  replaceSession(
    { id: 'sNullTs', project_id: p.id, source: 'claude-code', file_path: '/tmp/sNullTs.jsonl',
      started_at: iso(start), ended_at: iso(now),
      usage: JSON.stringify({ [MODEL]: { input: 1200, output: 240, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    Array.from({ length: 12 }, (_, i) => ({
      kind: 'assistant', model: MODEL, ts: iso(start + i * 120000),
      text: `assistant reply ${i} with enough text to attribute`,
      input_tokens: 100, output_tokens: 20,
    })),
  );
  // The untimestamped rows. replaceSession's event path always stamps a ts,
  // so these go in directly — the shape a transcript line with no `timestamp`
  // lands in (server/parsers/claudeCode.ts passes `o.timestamp` through). Two
  // of them, because the engines below read different columns: a tool_use for
  // the tool distributions, a text-carrying user turn for Content's
  // char-share composition.
  const maxSeq = db.prepare("SELECT MAX(seq) AS s FROM messages WHERE session_id = 'sNullTs'").get().s;
  db.prepare(`INSERT INTO messages (session_id, seq, ts, kind, tool_name, tool_input, tool_use_id)
              VALUES ('sNullTs', ?, NULL, 'tool_use', 'Grep', '{"pattern":"needle"}', 'nts1')`).run(maxSeq + 1);
  db.prepare(`INSERT INTO messages (session_id, seq, ts, kind, text)
              VALUES ('sNullTs', ?, NULL, 'user', 'an undated prompt, long enough to carry a char share')`).run(maxSeq + 2);
});

after(() => teardown?.());

const toolCount = (dist, name) => dist.find((t) => t.name === name)?.count ?? 0;

test('All range: a NULL-ts message counts — no range means no time filter', async () => {
  const r = await insights.computeInsights({ type: 'all' }, rangeOf(null));
  assert.equal(toolCount(r.toolDist, 'Grep'), 1);
  assert.equal(r.kindDist.find((k) => k.kind === 'tool_use')?.count, 1);
});

test('a bounded range excludes it — it has no timestamp to fall in the range', async () => {
  const r = await insights.computeInsights({ type: 'all' }, rangeOf(7));
  assert.equal(toolCount(r.toolDist, 'Grep'), 0);
  assert.equal(r.kindDist.find((k) => k.kind === 'tool_use'), undefined);
});

test('the same split holds for Explore, which reads the message range through the same context', () => {
  const q = { scope: { type: 'all' }, metric: 'requests', group: 'tool', rollup: 'total', topN: 10 };
  const all = explore.computeExplore({ ...q, range: rangeOf(null) });
  const bounded = explore.computeExplore({ ...q, range: rangeOf(7) });
  assert.equal(all.rows.find((row) => row.key === 'Grep')?.requests, 1);
  assert.equal(bounded.rows.find((row) => row.key === 'Grep'), undefined);
});

test('and for Content, whose composition buckets are message-level too', () => {
  const userBucket = (r) => r.composition.find((c) => c.key === 'user')?.tokens ?? 0;
  // The only `user` row in the fixture is the undated one, so its char share
  // is the whole bucket: present under All, absent under a bounded range.
  assert.ok(userBucket(content.computeContent({ type: 'all' }, rangeOf(null))) > 0);
  assert.equal(userBucket(content.computeContent({ type: 'all' }, rangeOf(7))), 0);
});
