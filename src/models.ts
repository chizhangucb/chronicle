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

// Per-model price core MOVED to `shared/pricing.ts` (CHI-351) so the `/ask`
// runner + its MCP server (scripts/**, server build) can price tokens too —
// `src/**` is client-only and not in that build graph. Re-exported here (VALUE
// re-export → relative path, NOT `@shared`; see the contextWindowFor note
// above) so every existing importer of `pricingFor`/`CostMode` from
// `models.ts` is unchanged, and there is still exactly ONE price table.
export { pricingFor, type CostMode, type Price } from '../shared/pricing.ts';
import { pricingFor } from '../shared/pricing.ts';
import type { CostMode } from '../shared/pricing.ts';

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
  mode: CostMode = 'theoretical',
): CostBreakdown | null {
  const p = pricingFor(model, day, mode);
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
  mode: CostMode = 'theoretical',
): CacheWriteByTtl | null {
  const p = pricingFor(model, day, mode);
  if (!p || !u) return null;
  const { cw5m, cw1h } = cacheWriteByTtl(u);
  return { cw5m: (cw5m * p.cw5m) / 1e6, cw1h: (cw1h * p.cw1h) / 1e6 };
}

// Total cost in USD for one model's aggregated token usage; null if unpriced.
export function costOf(model: string | null | undefined, u: ModelUsageInput | null | undefined, day?: string | null, mode: CostMode = 'theoretical'): number | null {
  const b = costBreakdownOf(model, u, day, mode);
  return b ? b.input + b.output + b.cacheWrite + b.cacheRead : null;
}
