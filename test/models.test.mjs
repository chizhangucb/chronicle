// Unit tests for src/models.ts's date-aware pricing (CHI-228): PRICING entries
// generalize to {to, rates} windows so a model whose list price changed on a
// known date (Sonnet 5's CHI-110 intro window, $2/$10 through 2026-08-31, then
// $3/$15) prices correctly per-day instead of one flat rate for all time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingFor, costOf, costBreakdownOf } from '../src/models.ts';

test('pricingFor: claude-sonnet-5 on an intro-window day returns the $2/$10 rate', () => {
  const p = pricingFor('claude-sonnet-5', '2026-08-15');
  assert.equal(p.input, 2);
  assert.equal(p.output, 10);
});

test('pricingFor: claude-sonnet-5 on the intro window\'s last day (2026-08-31) is still intro-priced (inclusive boundary)', () => {
  const p = pricingFor('claude-sonnet-5', '2026-08-31');
  assert.equal(p.input, 2);
  assert.equal(p.output, 10);
});

test('pricingFor: claude-sonnet-5 the day after the cutover (2026-09-01) returns the $3/$15 rate', () => {
  const p = pricingFor('claude-sonnet-5', '2026-09-01');
  assert.equal(p.input, 3);
  assert.equal(p.output, 15);
});

test('pricingFor: claude-sonnet-5 with no day param falls back to the latest window (today\'s pre-existing flat behavior, no regression)', () => {
  const p = pricingFor('claude-sonnet-5');
  assert.equal(p.input, 3);
  assert.equal(p.output, 15);
});

test('pricingFor: claude-sonnet-4 (not Sonnet 5) is unaffected by day — always the flat rate', () => {
  const early = pricingFor('claude-sonnet-4', '2026-08-15');
  const late = pricingFor('claude-sonnet-4', '2026-09-01');
  assert.equal(early.input, 3);
  assert.equal(late.input, 3);
});

test('costOf: claude-sonnet-5 usage on an intro-window day prices at $2/$10, not $3/$15', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  assert.equal(costOf('claude-sonnet-5', usage, '2026-08-15'), 2 + 10);
  assert.equal(costOf('claude-sonnet-5', usage, '2026-09-01'), 3 + 15);
});

test('costBreakdownOf: cache rates scale with the same window as input/output (5m 1.25x, 1h 2x, read 0.1x of input)', () => {
  const usage = { cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };
  const intro = costBreakdownOf('claude-sonnet-5', usage, '2026-08-15');
  assert.equal(intro.cacheWrite, 2 * 1.25 + 2 * 2);
  assert.ok(Math.abs(intro.cacheRead - 2 * 0.1) < 1e-9);
  const post = costBreakdownOf('claude-sonnet-5', usage, '2026-09-01');
  assert.equal(post.cacheWrite, 3 * 1.25 + 3 * 2);
  assert.ok(Math.abs(post.cacheRead - 3 * 0.1) < 1e-9);
});
