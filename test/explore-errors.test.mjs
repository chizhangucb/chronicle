// Explore's error counts, where the group value is a property of the SESSION
// (#306). project/source/session need no per-message attribution (nothing about
// those rows says WHICH tool errored), so they read the `sessions.error_count`
// column precomputed at import (server/db.ts replaceSession, shared/errors.ts
// heuristic) instead of pulling every tool_result head into JS and regexing it on
// every request. tool/skill/model/subagent/mcp/provider/hour still need the head
// query, because they attribute an error to something inside the session.
//
// Own temp DB (not test/explore.test.mjs's shared corpus) so the unpaired-result
// fixture below cannot perturb that file's token and error expectations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore, projectName;

// One more in-range erroring session than the default topN below, so every
// session-level query in this file runs with topN folding ACTIVE.
const FOLD_SESSIONS = 11;
// The three dated fixtures (sePaired, seUnpaired, seStale) plus the fold set: the
// whole corpus's error count, since every session here errors exactly once.
const ALL_ERRORS = 3 + FOLD_SESSIONS;

// 12 alternating user/assistant messages over 22 minutes, so each session clears both
// noise-gate thresholds and is not excluded by minorGate. Same shape as the other
// explore suites' rhythm fixtures.
function rhythmEvents(baseIso, extra = []) {
  const base = new Date(baseIso).getTime();
  const events = Array.from({ length: 12 }, (_, i) => ({
    kind: i % 2 === 0 ? 'user' : 'assistant',
    text: `msg ${i}`,
    ts: new Date(base + i * 2 * 60000).toISOString(),
    ...(i % 2 === 1 ? { model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50 } : {}),
  }));
  return [...events, ...extra];
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const proj = upsertProject('/tmp/proj-explore-errors');
  projectName = proj.name;

  // One erroring tool_result PAIRED to its tool_use: attributable to a tool.
  replaceSession(
    { id: 'sePaired', project_id: proj.id, source: 'claude-code', file_path: '/tmp/sePaired.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:30:00.000Z' },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'ep1', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', tool_use_id: 'ep1', text: 'Error: boom', ts: '2026-08-01T10:24:03.000Z' },
    ]),
  );
  // One erroring tool_result with NO tool_use row carrying its id, a real shape
  // (a truncated transcript, a result whose call was written by a prior session).
  // The tool it came from is unknowable, but the session still errored, so a
  // session-level group must count it.
  replaceSession(
    { id: 'seUnpaired', project_id: proj.id, source: 'opencode', file_path: '/tmp/seUnpaired.jsonl',
      started_at: '2026-08-02T10:00:00.000Z', ended_at: '2026-08-02T10:30:00.000Z' },
    rhythmEvents('2026-08-02T10:00:00.000Z', [
      { kind: 'tool_result', tool_use_id: 'orphan-9', text: 'Error: boom', ts: '2026-08-02T10:24:03.000Z' },
    ]),
  );

  // A session that overlaps a 7-day range (it ran until yesterday) but whose messages
  // all predate the range. Its precomputed error count is real, yet the ranked rows
  // hold no line for it (they are built from in-range messages), and its start bucket
  // sits a month outside the range.
  const DAY = 86400000;
  const staleNow = Date.now();
  replaceSession(
    { id: 'seStale', project_id: proj.id, source: 'codex', file_path: '/tmp/seStale.jsonl',
      started_at: new Date(staleNow - 30 * DAY).toISOString(),
      ended_at: new Date(staleNow - 1 * DAY).toISOString() },
    rhythmEvents(new Date(staleNow - 30 * DAY).toISOString(), [
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'es1', ts: new Date(staleNow - 30 * DAY + 3600000).toISOString() },
      { kind: 'tool_result', tool_use_id: 'es1', text: 'Error: boom', ts: new Date(staleNow - 30 * DAY + 3600001).toISOString() },
    ]),
  );

  // FOLD_SESSIONS erroring sessions INSIDE a 7-day range, one more than the default
  // topN, so group=session's ranked rows fold a real session into 'Other' and the
  // rollup below has to reconcile against the pre-fold group values (#330). Their
  // errors are UNPAIRED tool_results (no tool_use carries the id) so they add nothing
  // to the per-tool attribution above, and they run on `cursor` so the per-source
  // counts above stay about the two sessions that named those sources.
  for (let i = 0; i < FOLD_SESSIONS; i++) {
    const startedAt = new Date(staleNow - (1 + (i % 5)) * DAY).toISOString();
    const id = `seFold${String(i).padStart(2, '0')}`;
    replaceSession(
      { id, project_id: proj.id, source: 'cursor', file_path: `/tmp/${id}.jsonl`,
        started_at: startedAt, ended_at: new Date(new Date(startedAt).getTime() + 30 * 60000).toISOString() },
      rhythmEvents(startedAt, [
        { kind: 'tool_result', tool_use_id: `orphan-fold-${i}`, text: 'Error: boom',
          ts: new Date(new Date(startedAt).getTime() + 24 * 60000).toISOString() },
      ]),
    );
  }
});
after(() => teardown());

// The two numbers every reconciliation assertion below compares: the Detail table's
// total bar, and the stacked chart beside it.
function errorTotals(r) {
  return {
    rowTotal: r.rows.reduce((n, row) => n + row.errors, 0),
    bucketTotal: (r.buckets ?? []).reduce(
      (n, b) => n + Object.values(b.series).reduce((m, cell) => m + cell.errors, 0), 0),
  };
}

const q = { scope: { type: 'all' }, days: null, metric: 'errors', topN: 10 };

test('group=source counts every erroring tool_result in the session, paired or not', () => {
  const r = explore.computeExplore({ ...q, group: 'source', rollup: 'total' });
  assert.equal(r.rows.find((x) => x.key === 'claude-code')?.errors, 1);
  assert.equal(r.rows.find((x) => x.key === 'opencode')?.errors, 1,
    'an erroring result with no pairable tool_use is still an error for its source');
});

test('group=project sums the precomputed error count of every session in scope', () => {
  const r = explore.computeExplore({ ...q, group: 'project', rollup: 'total' });
  assert.equal(r.rows.find((x) => x.key === projectName)?.errors, ALL_ERRORS);
});

test('group=session reports each session own error count', () => {
  // topN above the corpus, so the two sessions this asserts on keep their own lines
  // instead of landing in 'Other' (the fold set is larger than the default cap).
  const r = explore.computeExplore({ ...q, group: 'session', rollup: 'total', topN: 50 });
  assert.equal(r.rows.find((x) => x.key === 'sePaired')?.errors, 1);
  assert.equal(r.rows.find((x) => x.key === 'seUnpaired')?.errors, 1);
});

// The other side of the same rule: a group that attributes an error to something
// INSIDE the session still needs the head query and its tool_use pairing, so an
// unpaired result attributes to no tool at all.
test('group=tool still attributes errors through the tool_use pairing', () => {
  const r = explore.computeExplore({ ...q, group: 'tool', rollup: 'total' });
  assert.equal(r.rows.find((x) => x.key === 'Bash')?.errors, 2); // sePaired + seStale
  assert.equal(r.rows.reduce((n, x) => n + x.errors, 0), 2,
    'the unpaired result names no tool, so it stays out of the per-tool attribution');
});

test('errors rollup: the buckets of a session-level group sum to its total', () => {
  for (const group of ['project', 'source', 'session']) {
    for (const rollup of ['daily', 'weekly', 'monthly']) {
      const r = explore.computeExplore({ ...q, group, rollup });
      const { rowTotal, bucketTotal } = errorTotals(r);
      assert.equal(rowTotal, ALL_ERRORS, `group=${group} rollup=${rollup}: total bar`);
      assert.equal(bucketTotal, rowTotal, `group=${group} rollup=${rollup}: stacked chart`);
    }
  }
});

// Under a range, the precomputed count is a whole-session total, so the chart's bars
// must still stay inside the range and still add up to the table beside them.
test('errors rollup under a range: bars stay inside the range and reconcile with the rows', () => {
  const firstInRange = (() => {
    const d = new Date(Date.now() - 7 * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  // seStale errored too, but only project (the group it shares with the in-range
  // sessions) carries it: under source and session it names a value the ranked rows
  // dropped, so neither the table nor the chart may show it.
  const expected = { project: FOLD_SESSIONS + 1, source: FOLD_SESSIONS, session: FOLD_SESSIONS };
  for (const group of ['project', 'source', 'session']) {
    const r = explore.computeExplore({
      scope: { type: 'all' }, days: 7, metric: 'errors', group, rollup: 'daily', topN: 10,
    });
    const { rowTotal, bucketTotal } = errorTotals(r);
    assert.ok(r.rows.length > 0, `group=${group}: the range holds messages, so the rows cannot be empty`);
    assert.ok((r.buckets ?? []).length > 0, `group=${group}: the range holds errors, so the chart cannot be empty`);
    assert.equal(rowTotal, expected[group], `group=${group}: total bar`);
    assert.equal(bucketTotal, rowTotal, `group=${group}: stacked chart must equal the total bar`);
    for (const b of r.buckets ?? []) {
      assert.ok(b.bucket >= firstInRange,
        `group=${group}: bucket ${b.bucket} falls outside the 7-day range (first in-range day ${firstInRange})`);
    }
  }
});

// The fold is what #330 turns on: with more in-range sessions than topN, a session the
// rows dropped for having no in-range messages used to slip into the 'Other' bar,
// because 'Other' IS a series key the rows carry. Pinned separately so a fixture that
// stopped folding could not quietly retire the case above.
test('errors rollup under a range: a dropped session cannot ride into the folded Other bar', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: 7, metric: 'errors', group: 'session', rollup: 'daily', topN: 10,
  });
  const other = r.rows.find((row) => row.key === 'Other');
  assert.ok(other, 'the fixture must exceed topN, or this pins nothing');
  assert.equal(other.otherCount, FOLD_SESSIONS - 10);
  const otherBucketed = (r.buckets ?? []).reduce((n, b) => n + (b.series.Other?.errors ?? 0), 0);
  assert.equal(otherBucketed, other.errors,
    "the Other bar must hold exactly the folded rows' errors, not every session the rows dropped");
});
