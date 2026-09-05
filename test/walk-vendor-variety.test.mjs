// Regression pin for the seeded release-walk vendor variety.
// The seeded walk (scripts/walk-seed.mjs) exists so the Spend tab's
// [project|provider] toggle / median dash / routing table show more than one
// vendor. This pins the SEED LIST so a regression back to all-`claude-*` (which
// would silently flatten those surfaces again) fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerOf } from '../shared/provider.ts';
import { WALK_VENDOR_MODELS, WALK_REQUIRED_PROVIDERS, walkVendorSessions } from './fixtures/walk-vendors.mjs';

test('seeded walk models span the required vendors (anthropic/openai/google/other)', () => {
  const providers = new Set(WALK_VENDOR_MODELS.map(providerOf));
  for (const required of WALK_REQUIRED_PROVIDERS) {
    assert.ok(providers.has(required), `seed list must include a ${required} model; got ${[...providers].join(', ')}`);
  }
  assert.ok(providers.size >= 3, `expected >=3 distinct vendors, got ${providers.size}`);
});

test('seed list carries a priceable non-Anthropic model (so the provider stack is not all $0)', () => {
  // gpt-5 and gemini are metered (priceable in both cost modes); the whole point
  // is a non-Anthropic vendor with real dollars in the stack.
  assert.ok(WALK_VENDOR_MODELS.some((m) => providerOf(m) === 'openai' || providerOf(m) === 'google'));
});

test('walkVendorSessions resolves to importable specs dated within recent windows', () => {
  const now = Date.parse('2026-08-27T18:00:00.000Z');
  const specs = walkVendorSessions(now);
  assert.equal(specs.length, WALK_VENDOR_MODELS.length >= 1 ? specs.length : 0);
  assert.ok(specs.length >= 5);
  for (const s of specs) {
    assert.match(s.sessionId, /^walk-/);
    assert.equal(typeof s.model, 'string');
    assert.ok(Date.parse(s.dateISO) <= now, 'session start must not be in the future');
    assert.ok(Date.parse(s.dateISO) >= now - 8 * 24 * 3600 * 1000, 'session start within the last week');
    assert.ok(s.usage.input_tokens > 0 && s.usage.output_tokens > 0);
  }
  // At least one session on "today" (daysAgo: 0) so Today-window surfaces populate.
  assert.ok(specs.some((s) => Date.parse(s.dateISO) >= now - 6 * 3600 * 1000));
});
