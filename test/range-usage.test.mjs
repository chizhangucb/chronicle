// Unit tests for server/rangeUsage.ts (feedback-round Task 1): the windowed-usage
// primitive that replaces the old `started_at >= cutoff` session gate (which drops a
// session that started before the range but ran into it) with an activity-span
// OVERLAP gate, plus per-session/per-model calibration of billed `sessions.usage` cells
// to the in-range share of per-message tokens.
//
// Same shared-temp-db-for-the-whole-file pattern as test/insights.test.mjs (see
// test/helpers.mjs): one DB, one `before` hook seeding every fixture session, each test
// scopes itself to its own session(s) via `AND s.id IN (...)` so tests stay independent
// without needing a fresh DB per test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, rangeUsageModule;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  rangeUsageModule = await import('../server/rangeUsage.ts');

  const { upsertProject, replaceSession } = dbModule;
  const proj = upsertProject('/tmp/range-usage-proj');

  // --- overlap-gating fixtures ---
  // Spans the window: started well before the cutoff, ended well after it. No
  // messages at all, so the fallback path (ratio 1) is what proves it was included —
  // the point of this fixture is purely "did overlapGate let it through", not the
  // scaling math (covered separately below).
  replaceSession(
    { id: 'sp1', project_id: proj.id, source: 'claude-code', file_path: '/tmp/sp1.jsonl',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-03T00:00:00.000Z',
      usage: JSON.stringify({ 'model-a': { input: 100, output: 50, cacheRead: 10, cacheWrite5m: 5, cacheWrite1h: 0 } }) },
    [],
  );
  // Entirely before the window: both started_at and ended_at predate the cutoff.
  replaceSession(
    { id: 'past1', project_id: proj.id, source: 'claude-code', file_path: '/tmp/past1.jsonl',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T12:00:00.000Z',
      usage: JSON.stringify({ 'model-a': { input: 999, output: 999, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    [],
  );

  // --- scaling-math fixture ---
  // Overlaps the window (started before cutoff, ended after). 4 messages for
  // 'model-a': 2 with ts BEFORE the cutoff (input_tokens=10 each, whole-session
  // contribution) and 2 AT/AFTER the cutoff (input_tokens=10 each, in-range
  // contribution) — whole=40, in-range=20, ratio=0.5.
  replaceSession(
    { id: 'scale1', project_id: proj.id, source: 'claude-code', file_path: '/tmp/scale1.jsonl',
      started_at: '2026-02-01T00:00:00.000Z', ended_at: '2026-02-03T00:00:00.000Z',
      usage: JSON.stringify({ 'model-a': { input: 100, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    [
      { kind: 'assistant', ts: '2026-02-01T01:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      { kind: 'assistant', ts: '2026-02-01T02:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      { kind: 'assistant', ts: '2026-02-02T01:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      { kind: 'assistant', ts: '2026-02-02T02:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
    ],
  );

  // --- fallback fixture ---
  // Overlaps the window; billed usage for 'model-a', but its messages are tagged
  // 'model-other' — so 'model-a' has ZERO per-message rows and must fall back to its
  // full billed cell.
  replaceSession(
    { id: 'fb1', project_id: proj.id, source: 'codex', file_path: '/tmp/fb1.jsonl',
      started_at: '2026-03-01T00:00:00.000Z', ended_at: '2026-03-03T00:00:00.000Z',
      usage: JSON.stringify({ 'model-a': { input: 77, output: 33, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    [
      { kind: 'assistant', ts: '2026-03-01T06:00:00.000Z', model: 'model-other', input_tokens: 40, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
    ],
  );

  // --- All-window exactness fixture ---
  // A skewed message distribution (nearly all tokens land "late") that WOULD produce a
  // very different scaled result under any cutoff — proves the cutoff===null path
  // ignores messages entirely and returns the raw billed cell.
  replaceSession(
    { id: 'all1', project_id: proj.id, source: 'claude-code', file_path: '/tmp/all1.jsonl',
      started_at: '2026-04-01T00:00:00.000Z', ended_at: '2026-04-10T00:00:00.000Z',
      usage: JSON.stringify({ 'model-a': { input: 123, output: 45, cacheRead: 6, cacheWrite5m: 7, cacheWrite1h: 8 } }) },
    [
      { kind: 'assistant', ts: '2026-04-01T00:01:00.000Z', model: 'model-a', input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      { kind: 'assistant', ts: '2026-04-09T23:59:00.000Z', model: 'model-a', input_tokens: 999, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
    ],
  );

  // --- local bucket key fixture ---
  // Two messages on different local calendar days/hours (spaced >24h apart so the
  // day bucket differs regardless of the test host's timezone), plus a fallback
  // model with zero message rows to exercise the started_at-derived bucket.
  replaceSession(
    { id: 'bkt1', project_id: proj.id, source: 'claude-code', file_path: '/tmp/bkt1.jsonl',
      started_at: '2026-05-01T03:00:00.000Z', ended_at: '2026-05-05T00:00:00.000Z',
      usage: JSON.stringify({
        'model-a': { input: 100, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        'model-fallback': { input: 50, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      }) },
    [
      { kind: 'assistant', ts: '2026-05-01T05:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
      { kind: 'assistant', ts: '2026-05-03T09:00:00.000Z', model: 'model-a', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_w5m_tokens: 0, cache_w1h_tokens: 0 },
    ],
  );
});

after(() => teardown());

// ---------------------------------------------------------------------------
// overlapGate
// ---------------------------------------------------------------------------

test('overlapGate: SQL fragment compares COALESCE(ended_at, started_at, "9") against a bind', () => {
  const { overlapGate } = rangeUsageModule;
  assert.equal(overlapGate('s'), `COALESCE(s.ended_at, s.started_at, '9') >= ?`);
  assert.equal(overlapGate('sessions'), `COALESCE(sessions.ended_at, sessions.started_at, '9') >= ?`);
});

// ---------------------------------------------------------------------------
// rangedUsage: overlap gating
// ---------------------------------------------------------------------------

test('rangedUsage: a session spanning the cutoff is included; one fully before it is excluded', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-01-02T00:00:00.000Z';
  const cells = rangedUsage(db, 'AND s.id IN (?, ?)', ['sp1', 'past1'], cutoff);
  const sessionIds = new Set(cells.map((c) => c.sessionId));
  assert.ok(sessionIds.has('sp1'), 'spanning session (ended_at >= cutoff) must be included');
  assert.ok(!sessionIds.has('past1'), 'session fully before the cutoff (ended_at < cutoff) must be excluded');

  // The included session's fallback cell (no messages) carries its full billed usage.
  const spCell = cells.find((c) => c.sessionId === 'sp1' && c.model === 'model-a');
  assert.ok(spCell);
  assert.equal(spCell.projectId, cells[0].projectId);
  assert.deepEqual(spCell.cells, { input: 100, output: 50, cacheRead: 10, cacheWrite5m: 5, cacheWrite1h: 0 });
});

// ---------------------------------------------------------------------------
// rangedUsage: scaling math
// ---------------------------------------------------------------------------

test('rangedUsage: half the message tokens in-range scales the billed cell by half', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  // Cutoff sits between the two "before" messages (Feb 1) and the two "in-range"
  // messages (Feb 2): whole-session sum = 40, in-range sum = 20 → ratio 0.5.
  const cutoff = '2026-02-02T00:00:00.000Z';
  const cells = rangedUsage(db, 'AND s.id = ?', ['scale1'], cutoff);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].model, 'model-a');
  assert.equal(cells[0].cells.input, 50, 'billed input 100 * ratio 0.5 = 50');
  assert.equal(cells[0].cells.output, 0);
});

test('rangedUsage: a cutoff after all messages scales the cell down to (near) zero', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-02-03T00:00:00.000Z'; // after every fixture message, still inside the session span
  const cells = rangedUsage(db, 'AND s.id = ?', ['scale1'], cutoff);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].cells.input, 0, 'no messages fall in-range (0/40 ratio) so the scaled cell is 0');
});

// ---------------------------------------------------------------------------
// rangedUsage: zero-message-row fallback
// ---------------------------------------------------------------------------

test('rangedUsage: a model with zero per-message rows falls back to its full billed cell', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-03-02T00:00:00.000Z'; // inside fb1's span
  const cells = rangedUsage(db, 'AND s.id = ?', ['fb1'], cutoff);
  // fb1's only messages are tagged 'model-other', not the billed 'model-a' — so
  // 'model-a' has zero per-message rows and must fall back to the full billed cell.
  const modelA = cells.find((c) => c.model === 'model-a');
  assert.ok(modelA);
  assert.deepEqual(modelA.cells, { input: 77, output: 33, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 0 });
  // 'model-other' has no billed usage entry, so it never appears as an output cell.
  assert.ok(!cells.some((c) => c.model === 'model-other'));
});

// ---------------------------------------------------------------------------
// rangedUsage: All-window exactness
// ---------------------------------------------------------------------------

test('rangedUsage: cutoff===null (All) returns the raw billed cell, ignoring message distribution', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cells = rangedUsage(db, 'AND s.id = ?', ['all1'], null);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0].cells, { input: 123, output: 45, cacheRead: 6, cacheWrite5m: 7, cacheWrite1h: 8 });
});

test('rangedUsage: All-window also includes sessions with no messages at all (past1)', () => {
  const { rangedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cells = rangedUsage(db, 'AND s.id = ?', ['past1'], null);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0].cells, { input: 999, output: 999, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

// ---------------------------------------------------------------------------
// bucketedUsage: local bucket keys
// ---------------------------------------------------------------------------

test('bucketedUsage: day buckets use LOCAL calendar dates derived from message ts', () => {
  const { bucketedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-05-01T00:00:00.000Z'; // before both messages, inside the session span
  const cells = bucketedUsage(db, 'AND s.id = ?', ['bkt1'], cutoff, 'day');
  const modelA = cells.filter((c) => c.model === 'model-a');
  // Two messages 2+ days apart in UTC (and every real-world local offset) land in two
  // distinct local day buckets, each getting half the billed input (ratio 10/20 each).
  const buckets = modelA.map((c) => c.bucket).sort();
  assert.equal(buckets.length, 2);
  // Compare against the SAME local-Date-derived format the production code uses,
  // rather than a hardcoded UTC string, so the assertion holds under any host timezone.
  const expected = ['2026-05-01T05:00:00.000Z', '2026-05-03T09:00:00.000Z']
    .map((iso) => {
      const d = new Date(iso);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    })
    .sort();
  assert.deepEqual(buckets, expected);
  for (const c of modelA) assert.equal(c.cells.input, 50, 'each bucket gets half of the billed 100 (10/20 message-token share)');
});

test('bucketedUsage: hour buckets use LOCAL hour-of-day format YYYY-MM-DDTHH', () => {
  const { bucketedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-05-01T00:00:00.000Z';
  const cells = bucketedUsage(db, 'AND s.id = ?', ['bkt1'], cutoff, 'hour');
  const modelA = cells.filter((c) => c.model === 'model-a');
  assert.equal(modelA.length, 2);
  for (const c of modelA) assert.match(c.bucket, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
});

test('bucketedUsage: a zero-message-row model lands its full billed cell on the started_at-derived local bucket', () => {
  const { bucketedUsage } = rangeUsageModule;
  const { db } = dbModule;
  const cutoff = '2026-05-01T00:00:00.000Z';
  const cells = bucketedUsage(db, 'AND s.id = ?', ['bkt1'], cutoff, 'day');
  const fallback = cells.filter((c) => c.model === 'model-fallback');
  assert.equal(fallback.length, 1, 'the whole billed cell lands on exactly one bucket, not split');
  assert.deepEqual(fallback[0].cells, { input: 50, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const d = new Date('2026-05-01T03:00:00.000Z'); // bkt1.started_at
  const p2 = (n) => String(n).padStart(2, '0');
  assert.equal(fallback[0].bucket, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`);
});
