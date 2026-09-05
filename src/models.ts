// Cost-math module for the client. The PRICE TABLE and cost functions now live
// in `shared/pricing.ts` so the server side (the
// the shared spend math) can price too — still ONE table, not duplicated. This
// file re-exports every pricing symbol so existing client importers
// (ExploreTab, costMode, rangedUsage, session/stats, session/OverviewMode, …)
// keep their `from './models.ts'` import path unchanged. Nothing about client
// behavior changes; the price table simply moved one folder over.
//
// Relative path, NOT the `@shared` alias — see the note in shared/pricing.ts
// and shared/contextWindows.ts: `@shared` value-imports throw
// ERR_MODULE_NOT_FOUND under plain `node --test`; relative resolves everywhere.
// verbatimModuleSyntax is on, so type re-exports use `export type`.
export {
  pricingFor,
  isSubscriptionCovered,
  costBreakdownOf,
  cacheWriteTokens,
  cacheWriteByTtl,
  cacheWriteCostByTtl,
  costOf,
  priceFnFor,
} from '../shared/pricing.ts';
export type {
  Price,
  PriceWindow,
  CostMode,
  ModelUsageInput,
  CostBreakdown,
  CacheWriteByTtl,
  PriceFn,
} from '../shared/pricing.ts';

// The shared money formatter (unchanged) — kept here so callers of the cost-math
// module can format without hand-rolling `toFixed`.
export { fmtMoney } from './format.ts';

// Context-window table (tokens) lives in `shared/contextWindows.ts` (model
// CONSTANTS, both client and server/content.ts need it). Re-exported here so
// existing importers (e.g. src/session/OverviewMode.tsx) don't change their path.
export { contextWindowFor } from '../shared/contextWindows.ts';
