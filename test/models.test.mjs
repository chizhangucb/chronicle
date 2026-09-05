// Unit tests for src/models.ts's date-aware pricing: PRICING entries
// generalize to {to, rates} windows so a model whose list price changed on a
// known date (Sonnet 5's intro window, $2/$10 through 2026-08-31, then
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

// ---- Real / theoretical cost toggle ----

test('costOf: mode defaults to theoretical (list price) — no regression for existing callers', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  // Same result as the 3-arg call: default mode must not change anything.
  assert.equal(costOf('claude-sonnet-5', usage, '2026-09-01'), costOf('claude-sonnet-5', usage, '2026-09-01', 'theoretical'));
  assert.equal(costOf('claude-sonnet-5', usage, '2026-09-01'), 3 + 15);
});

test('costOf: real mode returns 0 for a subscription-covered Claude model', () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000 };
  assert.equal(costOf('claude-opus', usage, undefined, 'real'), 0);
  // Theoretical is unchanged and non-zero.
  assert.ok(costOf('claude-opus', usage, undefined, 'theoretical') > 0);
});

test('costOf: gpt-5.6 family is priced (theoretical) and subscription-covered (real 0)', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  // sol 5/30, terra 2/12, luna 0.20/1.20 per 1M input/output.
  assert.equal(costOf('gpt-5.6-sol', usage), 5 + 30);
  assert.equal(costOf('gpt-5.6-terra', usage), 2 + 12);
  assert.ok(Math.abs(costOf('gpt-5.6-luna', usage) - (0.2 + 1.2)) < 1e-9);
  // Real mode: all covered → 0.
  assert.equal(costOf('gpt-5.6-sol', usage, undefined, 'real'), 0);
  assert.equal(costOf('gpt-5.6-terra', usage, undefined, 'real'), 0);
  assert.equal(costOf('gpt-5.6-luna', usage, undefined, 'real'), 0);
});

test('gpt-5.6 cache rates: cached-input 0.1x input, cache-write 1.25x input', () => {
  const usage = { cacheRead: 1_000_000, cacheWrite5m: 1_000_000 };
  const b = costBreakdownOf('gpt-5.6-sol', usage); // input rate 5
  assert.ok(Math.abs(b.cacheRead - 5 * 0.1) < 1e-9);
  assert.ok(Math.abs(b.cacheWrite - 5 * 1.25) < 1e-9);
});

test('Codex maps to gpt-5.6-terra pricing and is subscription-covered', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  assert.equal(costOf('codex', usage), 2 + 12); // terra rates
  assert.equal(costOf('codex', usage, undefined, 'real'), 0);
});

test('gpt-5.6-terra does NOT fall through to the broad gpt-5 metered rate', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  // gpt-5 metered would be 1.25 + 10 = 11.25; terra must win (2 + 12 = 14).
  assert.equal(costOf('gpt-5.6-terra', usage), 14);
  assert.notEqual(costOf('gpt-5.6-terra', usage), 1.25 + 10);
});

test('costOf: a NON-covered metered model (raw gpt-5) costs the same in both modes', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  const theo = costOf('gpt-5', usage, undefined, 'theoretical');
  const real = costOf('gpt-5', usage, undefined, 'real');
  assert.equal(theo, 1.25 + 10);
  assert.equal(real, theo); // not subscription covered → unchanged
});

test('real mode still resolves day-aware windows for a non-covered check, and covered stays 0 regardless of day', () => {
  const usage = { input: 1_000_000, output: 1_000_000 };
  // Covered Sonnet 5: 0 in real mode on both an intro-window day and after.
  assert.equal(costOf('claude-sonnet-5', usage, '2026-08-15', 'real'), 0);
  assert.equal(costOf('claude-sonnet-5', usage, '2026-09-01', 'real'), 0);
  // Theoretical still day-aware (intro $2/$10 vs post $3/$15).
  assert.equal(costOf('claude-sonnet-5', usage, '2026-08-15', 'theoretical'), 2 + 10);
  assert.equal(costOf('claude-sonnet-5', usage, '2026-09-01', 'theoretical'), 3 + 15);
});

test('pricingFor: real mode returns an all-zero price for a covered model, list rates for theoretical', () => {
  const real = pricingFor('claude-opus', undefined, 'real');
  assert.equal(real.input, 0);
  assert.equal(real.output, 0);
  const theo = pricingFor('claude-opus', undefined, 'theoretical');
  assert.equal(theo.input, 5);
  assert.equal(theo.output, 25);
});
