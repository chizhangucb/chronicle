import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from '../src/relativeTime.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z').getTime();

test('formatRelativeTime: null/undefined is "never"', () => {
  assert.equal(formatRelativeTime(null, NOW), 'never');
});

test('formatRelativeTime: under 10s is "just now"', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 4000).toISOString(), NOW), 'just now');
});

test('formatRelativeTime: seconds', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 32000).toISOString(), NOW), '32s ago');
});

test('formatRelativeTime: minutes', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 5 * 60000).toISOString(), NOW), '5m ago');
});

test('formatRelativeTime: hours', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 3 * 3600000).toISOString(), NOW), '3h ago');
});

test('formatRelativeTime: days (1-6), capped label at 6d', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 2 * 86400000).toISOString(), NOW), '2d ago');
  assert.equal(formatRelativeTime(new Date(NOW - 9 * 86400000).toISOString(), NOW), '9d ago');
});

test('formatRelativeTime: invalid ISO string is "never"', () => {
  assert.equal(formatRelativeTime('not-a-date', NOW), 'never');
});
