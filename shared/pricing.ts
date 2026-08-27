// Per-model price core. MOVED here from src/models.ts (CHI-351) so it lives in
// ONE place that BOTH the client bundle AND the server/scripts build can import
// — `/ask`'s headless runner + its stdio MCP server (scripts/**, compiled into
// the server build) must price tokens, and `src/**` is a client-only tree not
// in the server build graph. `shared/` already carries the sibling model
// constants (contextWindows.ts) for exactly this reason. src/models.ts now
// re-exports every symbol below, so no client caller changed and there is still
// ONE price table (no server-side duplication — CLAUDE.md's rule holds: this is
// the single source, reused, not copied).
//
// Prices are USD per 1M tokens, from the Anthropic pricing table
// (platform.claude.com). 5m and 1h cache writes are priced separately — Claude
// Code's /usage bills each tier, and a session can be entirely 1h-cached.
// Used to reproduce /usage cost from raw token counts (logs carry tokens, not $).
// Ordered: more specific prefixes first.
export interface Price {
  input: number;
  output: number;
  cw5m: number;
  cw1h: number;
  cacheRead: number;
}
const P = (input: number, output: number, cw5m: number, cw1h: number, cacheRead: number): Price =>
  ({ input, output, cw5m, cw1h, cacheRead });

// A model's price can change on a known date (e.g. intro pricing that steps up
// after a launch window). `windows` is ordered earliest-to-latest; a window
// applies while `day <= to` (inclusive, matching Varde's `spend.ts`
// `priceForModel`, CHI-110). The last window's `to` is always null (applies
// indefinitely) — that's also what a caller with no `day` resolves to, so
// day-less callers keep today's flat-rate behavior with no regression.
export interface PriceWindow {
  to: string | null;
  rates: Price;
}
const flat = (rates: Price): PriceWindow[] => [{ to: null, rates }];

function resolveRates(windows: PriceWindow[], day: string | null | undefined): Price {
  if (day) for (const w of windows) if (w.to === null || day <= w.to) return w.rates;
  return windows[windows.length - 1].rates;
}

// Cost mode (CHI-233 Part C). "theoretical" = list price, what a metered API
// caller would pay; the historical default, so every pre-existing caller keeps
// its behavior. "real" = what Chi actually pays: models covered by a flat-rate
// subscription (Claude tiers, the gpt-5.6 family / Codex) bill effectively $0
// per token, so real cost is 0 for them. Non-covered models (raw gpt-5/gpt-4/
// gemini metered access) cost the same in both modes.
export type CostMode = 'theoretical' | 'real';

// gpt-5.6 family cache convention (no separate 5m/1h TTL tiers like Claude):
// cached input reads at 0.1x input, cache writes at 1.25x input. Both cw tiers
// carry the same 1.25x figure so a single cw number prices either TTL bucket.
const gpt56 = (input: number, output: number): Price =>
  P(input, output, input * 1.25, input * 1.25, input * 0.1);

// Sonnet 5's Chi-approved (CHI-110) intro-pricing window: $2/$10 per MTok
// through 2026-08-31, then $3/$15 — mirrors Varde's SONNET5_INTRO_END exactly.
const SONNET5_INTRO_END = '2026-08-31';

// [prefix, windows, subscriptionCovered]. `subscriptionCovered` marks a tier
// as billed under Chi's flat subscription: its theoretical (list) cost is real
// math, but its "real" cost is 0 (CHI-233 Part C). All Claude tiers and the
// whole gpt-5.6 family (Codex is gpt-5.6-terra) are covered; raw gpt-5/gpt-4/
// gemini metered access is not.
const PRICING: [string, PriceWindow[], boolean][] = [
  ['claude-fable-5', flat(P(10, 50, 12.5, 20, 1)), true],
  ['claude-mythos', flat(P(10, 50, 12.5, 20, 1)), true],
  ['claude-opus-4-1', flat(P(15, 75, 18.75, 30, 1.5)), true], // Opus 4.1 (deprecated) — old tier
  ['claude-opus-4-0', flat(P(15, 75, 18.75, 30, 1.5)), true], // Opus 4.0 (retired) — old tier
  ['claude-opus', flat(P(5, 25, 6.25, 10, 0.5)), true],        // Opus 4.8/4.7/4.6/4.5 + default
  ['claude-sonnet-5', [
    { to: SONNET5_INTRO_END, rates: P(2, 10, 2.5, 4, 0.2) },
    { to: null, rates: P(3, 15, 3.75, 6, 0.3) },
  ], true],
  ['claude-sonnet', flat(P(3, 15, 3.75, 6, 0.3)), true],        // 4.6/4.5/4 — never intro-priced
  ['claude-haiku', flat(P(1, 5, 1.25, 2, 0.1)), true],
  ['claude', flat(P(5, 25, 6.25, 10, 0.5)), true],
  // gpt-5.6 family (per 1M): sol 5/30, terra 2/12, luna 0.20/1.20 — subscription
  // covered. MUST precede the broad 'gpt-5' prefix below (m.includes matching),
  // or "gpt-5.6-terra" would fall through to the gpt-5 metered rate.
  ['gpt-5.6-sol', flat(gpt56(5, 30)), true],
  ['gpt-5.6-terra', flat(gpt56(2, 12)), true],
  ['gpt-5.6-luna', flat(gpt56(0.2, 1.2)), true],
  ['codex', flat(gpt56(2, 12)), true], // Codex = gpt-5.6-terra
  // Best-effort for non-Claude sources Chronicle can import (no cache tiers),
  // metered (NOT subscription covered).
  ['gpt-5', flat(P(1.25, 10, 1.25, 1.25, 0.125)), false],
  ['gpt-4', flat(P(2.5, 10, 2.5, 2.5, 1.25)), false],
  ['gemini', flat(P(1.25, 10, 1.25, 1.25, 0.3125)), false],
];

const ZERO_PRICE: Price = P(0, 0, 0, 0, 0);

// `day` (YYYY-MM-DD) selects which pricing window applies for models with a
// date-dependent rate (e.g. Sonnet 5's intro window); omit it to get the
// latest/current rate. `mode` defaults to "theoretical" (list price) so every
// pre-existing caller is unchanged; "real" returns an all-zero price for a
// subscription-covered tier (its billed cost under Chi's plan is ~$0).
export function pricingFor(model: string | null | undefined, day?: string | null, mode: CostMode = 'theoretical'): Price | null {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, windows, covered] of PRICING) if (m.includes(prefix)) {
    if (mode === 'real' && covered) return ZERO_PRICE;
    return resolveRates(windows, day);
  }
  return null;
}
