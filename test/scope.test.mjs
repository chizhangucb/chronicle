import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeClause } from '../server/scope.ts';

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
