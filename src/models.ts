// PR1 design-system foundation: re-export the shared money formatter so any
// caller of `models.ts` (the cost-math module) can format its own output
// without hand-rolling `toFixed`. NOTE: as of this PR, `models.ts` itself had
// no pre-existing `fmtMoney` to align — the real duplicated (ungrouped,
// `toFixed`-based) money formatters live as file-local functions in
// `InsightsPage.tsx` and `ExploreTab.tsx`. This re-export is additive only
// (no existing caller imports `fmtMoney` from here today), so it carries zero
// behavior-change risk; consolidating the two UI-file duplicates onto it is
// left to a follow-up since those two files aren't in this PR's touch list.
export { fmtMoney } from './format.ts';

// Context-window table (tokens) now lives in `shared/contextWindows.ts` — both
// this client module and server/content.ts need it (Content tab's
// highContextRel characteristic), so it's mirrored into `shared/` once
// instead of two hand-synced copies. Windows are model CONSTANTS, not
// prices — the price table below stays client-only, per CLAUDE.md's rule
// that pricing is never duplicated server-side. Re-exported here so existing
// importers (e.g. src/session/OverviewMode.tsx) don't need to change their
// import path.
//
// Relative path, NOT the `@shared` alias: every other `@shared` import in
// this codebase is `import type` (erased entirely at build/strip time, so it
// never needs real module resolution). This is a VALUE re-export, and
// `@shared` is only wired up as a resolvable specifier in vite.config.js's
// bundler alias + tsconfig's type-check `paths` — plain `node --test` (how
// this module's consumers, e.g. test/session-stats.test.mjs, actually run)
// has neither, so a value-level `from '@shared/...'` throws
// ERR_MODULE_NOT_FOUND at runtime outside Vite. The relative path resolves
// correctly under both Vite and plain Node.
export { contextWindowFor } from '../shared/contextWindows.ts';

// Per-model list price in USD per 1M tokens, from the Anthropic pricing table
// (platform.claude.com). 5m and 1h cache writes are priced separately — Claude
// Code's /usage bills each tier, and a session can be entirely 1h-cached.
// Used to reproduce /usage cost from raw token counts (logs carry tokens, not $).
// Ordered: more specific prefixes first.
interface Price {
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
interface PriceWindow {
  to: string | null;
  rates: Price;
}
const flat = (rates: Price): PriceWindow[] => [{ to: null, rates }];

function resolveRates(windows: PriceWindow[], day: string | null | undefined): Price {
  if (day) for (const w of windows) if (w.to === null || day <= w.to) return w.rates;
  return windows[windows.length - 1].rates;
}

// Sonnet 5's Chi-approved (CHI-110) intro-pricing window: $2/$10 per MTok
// through 2026-08-31, then $3/$15 — mirrors Varde's SONNET5_INTRO_END exactly.
const SONNET5_INTRO_END = '2026-08-31';

const PRICING: [string, PriceWindow[]][] = [
  ['claude-fable-5', flat(P(10, 50, 12.5, 20, 1))],
  ['claude-mythos', flat(P(10, 50, 12.5, 20, 1))],
  ['claude-opus-4-1', flat(P(15, 75, 18.75, 30, 1.5))], // Opus 4.1 (deprecated) — old tier
  ['claude-opus-4-0', flat(P(15, 75, 18.75, 30, 1.5))], // Opus 4.0 (retired) — old tier
  ['claude-opus', flat(P(5, 25, 6.25, 10, 0.5))],        // Opus 4.8/4.7/4.6/4.5 + default
  ['claude-sonnet-5', [
    { to: SONNET5_INTRO_END, rates: P(2, 10, 2.5, 4, 0.2) },
    { to: null, rates: P(3, 15, 3.75, 6, 0.3) },
  ]],
  ['claude-sonnet', flat(P(3, 15, 3.75, 6, 0.3))],        // 4.6/4.5/4 — never intro-priced
  ['claude-haiku', flat(P(1, 5, 1.25, 2, 0.1))],
  ['claude', flat(P(5, 25, 6.25, 10, 0.5))],
  // Best-effort for non-Claude sources Chronicle can import (no cache tiers).
  ['gpt-5', flat(P(1.25, 10, 1.25, 1.25, 0.125))],
  ['gpt-4', flat(P(2.5, 10, 2.5, 2.5, 1.25))],
  ['gemini', flat(P(1.25, 10, 1.25, 1.25, 0.3125))],
];

// `day` (YYYY-MM-DD) selects which pricing window applies for models with a
// date-dependent rate (e.g. Sonnet 5's intro window); omit it to get the
// latest/current rate.
export function pricingFor(model: string | null | undefined, day?: string | null): Price | null {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, windows] of PRICING) if (m.includes(prefix)) return resolveRates(windows, day);
  return null;
}

// A single model's aggregated token usage, as read from `sessions.usage`
// (parsed JSON) or built up client-side. Diverges from shared `ModelUsage`
// (`{input,output,cacheWrite5m,cacheWrite1h,cacheRead}`): this module must also
// accept the LEGACY shape (`cacheWrite`, pre-TTL-split imports), which the
// shared contract deliberately excludes since new imports never write it. Kept
// as a local, honest type rather than force-fitting `@shared`'s `Usage`.
export interface ModelUsageInput {
  input?: number | null;
  output?: number | null;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  /** Legacy pre-TTL-split field; treated as a 5-minute-tier write. */
  cacheWrite?: number | null;
  cacheRead?: number | null;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// Per-category cost in USD for one model's aggregated token usage; null if the
// model is unpriced. Handles both the new usage shape ({cacheWrite5m, cacheWrite1h})
// and the legacy one ({cacheWrite}, treated as 5m). Static lookup — no fetch.
// `day` (YYYY-MM-DD) selects the pricing window for date-dependent rates
// (e.g. Sonnet 5's intro window); omit for the latest/current rate.
export function costBreakdownOf(
  model: string | null | undefined,
  u: ModelUsageInput | null | undefined,
  day?: string | null,
): CostBreakdown | null {
  const p = pricingFor(model, day);
  if (!p || !u) return null;
  const cw5 = u.cacheWrite5m ?? u.cacheWrite ?? 0;
  const cw1 = u.cacheWrite1h ?? 0;
  return {
    input: ((u.input || 0) * p.input) / 1e6,
    output: ((u.output || 0) * p.output) / 1e6,
    cacheWrite: (cw5 * p.cw5m + cw1 * p.cw1h) / 1e6,
    cacheRead: ((u.cacheRead || 0) * p.cacheRead) / 1e6,
  };
}

// Combined cache-write token count across both tiers (for display).
export function cacheWriteTokens(u: ModelUsageInput): number {
  return (u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0) || (u.cacheWrite ?? 0);
}

export interface CacheWriteByTtl {
  cw5m: number;
  cw1h: number;
}

// Cache-write tokens split by TTL tier, for TTL-labeled display. Legacy logs
// only carry {cacheWrite} — those were billed at the 5-minute rate, so treat
// them as 5m. { cw5m, cw1h } in tokens.
export function cacheWriteByTtl(u: ModelUsageInput | null | undefined): CacheWriteByTtl {
  if (!u) return { cw5m: 0, cw1h: 0 };
  return { cw5m: u.cacheWrite5m ?? u.cacheWrite ?? 0, cw1h: u.cacheWrite1h ?? 0 };
}

// Per-TTL cache-write cost in USD for one model's usage; null if unpriced.
export function cacheWriteCostByTtl(
  model: string | null | undefined,
  u: ModelUsageInput | null | undefined,
  day?: string | null,
): CacheWriteByTtl | null {
  const p = pricingFor(model, day);
  if (!p || !u) return null;
  const { cw5m, cw1h } = cacheWriteByTtl(u);
  return { cw5m: (cw5m * p.cw5m) / 1e6, cw1h: (cw1h * p.cw1h) / 1e6 };
}

// Total cost in USD for one model's aggregated token usage; null if unpriced.
export function costOf(model: string | null | undefined, u: ModelUsageInput | null | undefined, day?: string | null): number | null {
  const b = costBreakdownOf(model, u, day);
  return b ? b.input + b.output + b.cacheWrite + b.cacheRead : null;
}
