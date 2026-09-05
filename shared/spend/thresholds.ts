// shared/spend/thresholds.ts
// The ONE spend-threshold + honesty-definition registry, shared by the client
// (page state-words + meters) and the shared spend math (shared/spend/*) so a
// number in a tip can never drift from the number that colors the reading.
// Ported from Varde's aggregator/config.ts (DEFAULT_CONFIG.anomaly/detectors/
// budget), src/lib/thresholds.ts (graded state-words), and
// aggregator/sources/spend-detectors.ts (the *_DEFINITION honesty strings +
// PREMIUM_INPUT_RATE) + spend.ts (DIM_FLAG_FLOOR_USD). CHI-324 2a / D9.
//
// These shape the WORDS next to a reading and the FLAG lines, never the
// collected numbers themselves. Relative-import module (never @shared), value
// export — same B3 rule as shared/pricing.ts.

// ---- Anomaly (spend.ts computeAnomaly) ----
export interface AnomalyThresholds {
  /** Flag when today's cost exceeds this multiple of the trailing median. */
  multiplier: number;
  /** Re-fire an already-flagged day only past this higher multiple. */
  escalation: number;
  /** Trailing active-day window for the median baseline. */
  windowDays: number;
  /** Anthropic's published ~$/dev/active-day — a faint reference line only. */
  benchmarkPerDay: number;
  /** A dimension value must clear this $ floor before it can be flagged as a
   * mover (spend.ts DIM_FLAG_FLOOR_USD), so sub-dollar noise never "moves". */
  dimFlagFloorUsd: number;
}

// ---- Detectors (config.ts detectors + spend-detectors.ts) ----
export interface DetectorThresholds {
  jumboOutputTokens: number;
  longContextTokens: number;
  /** Cap on non-human gaps when summing agent-active time, minutes. */
  activeGapCapMin: number;
  /** Right-sizing estimate: a premium-model message with output + context both
   * below these looks Sonnet-sized (labeled estimate, never a hard claim). */
  rightsizingMaxOutputTokens: number;
  rightsizingMaxContextTokens: number;
  /** $/MTok input rate at or above which a model counts as "premium" for the
   * right-sizing detector (fable/mythos + opus >= 4.5 qualify). */
  premiumInputRate: number;
}

// ---- Budget posture (spend.ts month math + src/lib/thresholds.ts) ----
export interface BudgetThresholds {
  /** month-to-date / budget at/above which state = "approaching". */
  approaching: number;
  /** month-to-date / budget at/above which state = "over budget". */
  over: number;
  /** Below this many elapsed days of the month, a month-end projection is
   * noise and is suppressed (spend.ts monthEndForecast returns null < 3). */
  minDaysForProjection: number;
}

// ---- Graded state-words (src/lib/thresholds.ts) ----
export interface StateWordThresholds {
  cacheHitHealthy: number; // >= healthy; below is at least "check"
  cacheHitLow: number;     // < is "low"
  jumboHealthyMax: number; // share of messages
  longContextHealthyMax: number; // share of messages
  errorHealthyMax: number; // share of assistant rows
}

export interface SpendThresholds {
  anomaly: AnomalyThresholds;
  detectors: DetectorThresholds;
  budget: BudgetThresholds;
  stateWords: StateWordThresholds;
}

// Shipped defaults — mirror Varde's DEFAULT_CONFIG exactly. A future gated
// editor (D5 budget-config; later detector tuning) overrides key by key; the
// shared math always takes a resolved SpendThresholds so callers can inject.
export const DEFAULT_SPEND_THRESHOLDS: SpendThresholds = {
  anomaly: { multiplier: 1.75, escalation: 3, windowDays: 14, benchmarkPerDay: 13, dimFlagFloorUsd: 1 },
  detectors: {
    jumboOutputTokens: 3000,
    longContextTokens: 150_000,
    activeGapCapMin: 10,
    rightsizingMaxOutputTokens: 300,
    rightsizingMaxContextTokens: 50_000,
    premiumInputRate: 5,
  },
  budget: { approaching: 0.8, over: 1, minDaysForProjection: 3 },
  stateWords: {
    cacheHitHealthy: 0.7,
    cacheHitLow: 0.4,
    jumboHealthyMax: 0.05,
    longContextHealthyMax: 0.2,
    errorHealthyMax: 0.005,
  },
};

// A graded state word + its severity, so page copy and tip copy grade a reading
// the same way (never color alone — the word travels with the reading, per the
// design-QA rubric's status-color rule).
export type StateSeverity = 'ok' | 'warn' | 'danger';
export interface StateWord {
  word: string;
  severity: StateSeverity;
}

// Cache hit rate: higher is better.
export function gradeCacheHit(rate: number, t: StateWordThresholds = DEFAULT_SPEND_THRESHOLDS.stateWords): StateWord {
  if (rate >= t.cacheHitHealthy) return { word: 'healthy', severity: 'ok' };
  if (rate < t.cacheHitLow) return { word: 'low', severity: 'danger' };
  return { word: 'check', severity: 'warn' };
}

// A share-of-messages/rows reading where LOWER is better (jumbo, long-context,
// error rate); anything above the healthy max is at least "check".
export function gradeShareLowerBetter(share: number, healthyMax: number): StateWord {
  if (share <= healthyMax) return { word: 'healthy', severity: 'ok' };
  if (share >= healthyMax * 2) return { word: 'high', severity: 'danger' };
  return { word: 'check', severity: 'warn' };
}

// Budget posture from month-to-date / budget.
export function gradeBudget(share: number, t: BudgetThresholds = DEFAULT_SPEND_THRESHOLDS.budget): StateWord {
  if (share >= t.over) return { word: 'over budget', severity: 'danger' };
  if (share >= t.approaching) return { word: 'approaching', severity: 'warn' };
  return { word: 'on track', severity: 'ok' };
}

// ---- Honesty definitions (spend-detectors.ts *_DEFINITION, verbatim) ----
// Rendered verbatim as the in-UI info icon for each derived metric (the rule:
// every derived metric shows its definition).
export const ACTIVE_TIME_DEFINITION =
  'Sum of gaps between consecutive session events, excluding each gap that precedes a genuine human prompt ' +
  '(synthetic rows: system reminders, task notifications, command echoes do not count as human; interrupts and ' +
  'permission responses do), capping every other gap at the configured limit, except gaps ending in a tool_result ' +
  'whose matching tool_use is the immediately prior event (long builds and test suites count fully). ' +
  'Agent run span is the same sessions’ uncapped wall-clock, first event to last.';

export const CACHE_CHURN_DEFINITION =
  'Dollars paid in cache-write premium inside sessions that wrote more cache tokens than they read back: ' +
  'context was being rebuilt faster than it was reused. Write premium = 1h writes at 2x input rate minus the ' +
  '1x base, 5m writes at 1.25x minus base.';

export const RIGHT_SIZING_DEFINITION =
  'ESTIMATE. Messages on a premium model (input rate >= $5/MTok) whose output and context both sit under the ' +
  'configured thresholds look small enough for Sonnet; the figure is what those exact token counts would have ' +
  'saved at current Sonnet rates. It cannot know whether the small reply needed frontier reasoning.';

export const REREADS_DEFINITION =
  'Read tool calls that fetched a file already read earlier in the same session. Wasted tokens are ESTIMATED ' +
  'from the repeated results’ content length at ~4 characters per token.';

// The MCP double-count caveat (CHI-324 D6): a single call can fan out to several
// MCP servers, so per-server spend double-counts and does not sum to the day total.
export const MCP_DOUBLE_COUNT_DEFINITION =
  'One agent turn can call several MCP servers, so a turn’s spend is attributed to each server it used. ' +
  'Per-server totals therefore double-count and do not sum to the day total — read them as per-server ' +
  'exposure, not a partition of spend.';
