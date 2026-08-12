import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtInt, fmtMoney, pluralize } from '../src/format.ts';

test('fmtInt: groups thousands', () => {
  assert.equal(fmtInt(60589), '60,589');
});

test('fmtInt: NaN is em dash', () => {
  assert.equal(fmtInt(NaN), '—');
});

test('fmtMoney: default 0dp, grouped', () => {
  assert.equal(fmtMoney(5378), '$5,378');
});

test('fmtMoney: 2dp, grouped', () => {
  assert.equal(fmtMoney(5378.34, 2), '$5,378.34');
});

test('fmtMoney: NaN is em dash', () => {
  assert.equal(fmtMoney(NaN), '—');
});

test('pluralize: singular', () => {
  assert.equal(pluralize(1, 'session', 'sessions'), '1 session');
});

test('pluralize: plural', () => {
  assert.equal(pluralize(2, 'session', 'sessions'), '2 sessions');
});
