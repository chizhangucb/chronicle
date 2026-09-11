// shared/spend/thresholds.ts
// The ONE spend-threshold + honesty-definition registry, shared by the client
// (page state-words + meters) and the shared spend math (shared/spend/*) so a
// number in a tip can never drift from the number that colors the reading.
//
// These shape the WORDS next to a reading and the FLAG lines, never the
// collected numbers themselves. Imported by relative path from both sides,
// like shared/pricing.ts.

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
interface DetectorThresholds {
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
interface StateWordThresholds {
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

// Shipped defaults. A future gated
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
type StateSeverity = 'ok' | 'warn' | 'danger';
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

