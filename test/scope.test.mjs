import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeClause, queryContext, rangeOf, whereOf } from '../server/scope.ts';

test('scopeClause: all → empty fragment, no params', () => {
  assert.deepEqual(scopeClause({ type: 'all' }), { sql: '', params: [] });
});
test('scopeClause: project → project_id filter', () => {
  assert.deepEqual(scopeClause({ type: 'project', id: 7 }), { sql: 'AND s.project_id = ?', params: [7] });
});
test('scopeClause: session → id filter', () => {
  assert.deepEqual(scopeClause({ type: 'session', id: 's1' }), { sql: 'AND s.id = ?', params: ['s1'] });
});
test('scopeClause: project/session with missing id falls back to all (no crash)', () => {
  assert.deepEqual(scopeClause({ type: 'project' }), { sql: '', params: [] });
});

// ---- queryContext: one place that hands an engine its scope clause, minor
// gate and the three range fragments (session overlap, message timestamp,
// token in-range share). Every engine takes (scope, range) and reads them
// from here, so the minor gate is written once.
const NOW = Date.parse('2026-03-10T12:00:00.000Z');

test('rangeOf: a bounded range carries days, now and the derived cutoff', () => {
  const range = rangeOf(7, NOW);
  assert.equal(range.days, 7);
  assert.equal(range.now, NOW);
  assert.equal(range.cutoffIso, new Date(NOW - 7 * 86400000).toISOString());
});

test('rangeOf: the All range has no cutoff', () => {
  assert.deepEqual(rangeOf(null, NOW), { days: null, now: NOW, cutoffIso: null });
});

test('queryContext: hands over the scope clause and the minor gate together', () => {
  const q = queryContext({ type: 'project', id: 7 }, rangeOf(7, NOW));
  assert.deepEqual(q.scopeSql, { sql: 'AND s.project_id = ?', params: [7] });
  assert.equal(q.minor, 'AND COALESCE(s.minor,0)=0');
  assert.deepEqual(q.where, { sql: 'AND COALESCE(s.minor,0)=0 AND s.project_id = ?', params: [7] });
});

test('queryContext: session scope drops the minor gate (a directly-opened session is never hidden)', () => {
  const q = queryContext({ type: 'session', id: 's1' }, rangeOf(7, NOW));
  assert.equal(q.minor, '');
  assert.deepEqual(q.where, { sql: 'AND s.id = ?', params: ['s1'] });
});

test('queryContext: a session is in range by OVERLAP of its activity span', () => {
  const q = queryContext({ type: 'all' }, rangeOf(7, NOW));
  const cutoff = new Date(NOW - 7 * 86400000).toISOString();
  assert.deepEqual(q.sessions(), { sql: "AND COALESCE(s.ended_at, s.started_at, '9') >= ?", params: [cutoff] });
  assert.deepEqual(q.sessions('x'), { sql: "AND COALESCE(x.ended_at, x.started_at, '9') >= ?", params: [cutoff] });
});

test('queryContext: a message is in range by TIMESTAMP', () => {
  const q = queryContext({ type: 'all' }, rangeOf(30, NOW));
  const cutoff = new Date(NOW - 30 * 86400000).toISOString();
  assert.deepEqual(q.messages(), { sql: 'AND m.ts >= ?', params: [cutoff] });
  assert.deepEqual(q.messages('r'), { sql: 'AND r.ts >= ?', params: [cutoff] });
});

test('queryContext: tokens are in range by their IN-RANGE SHARE (the rangeUsage cutoff)', () => {
  assert.deepEqual(queryContext({ type: 'all' }, rangeOf(30, NOW)).tokens,
    { cutoffIso: new Date(NOW - 30 * 86400000).toISOString() });
  assert.deepEqual(queryContext({ type: 'all' }, rangeOf(null, NOW)).tokens, { cutoffIso: null });
});

test('queryContext: the All range filters nothing — every session and message is in range', () => {
  const q = queryContext({ type: 'all' }, rangeOf(null, NOW));
  assert.deepEqual(q.sessions(), { sql: '', params: [] });
  assert.deepEqual(q.messages(), { sql: '', params: [] });
});

test('whereOf: composes fragments into one WHERE body, params in fragment order', () => {
  const q = queryContext({ type: 'project', id: 7 }, rangeOf(7, NOW));
  const cutoff = new Date(NOW - 7 * 86400000).toISOString();
  const w = whereOf(q.sessions(), q.where, "AND m.kind = 'tool_use'", q.messages());
  assert.equal(w.sql, "COALESCE(s.ended_at, s.started_at, '9') >= ? AND COALESCE(s.minor,0)=0 AND s.project_id = ? AND m.kind = 'tool_use' AND m.ts >= ?");
  assert.deepEqual(w.params, [cutoff, 7, cutoff]);
});

test('whereOf: an all-empty composition is a true predicate, not a syntax error', () => {
  const q = queryContext({ type: 'session', id: 's1' }, rangeOf(null, NOW));
  assert.deepEqual(whereOf(q.sessions(), q.messages()), { sql: '1=1', params: [] });
  assert.deepEqual(whereOf(q.sessions(), q.where), { sql: 's.id = ?', params: ['s1'] });
});
