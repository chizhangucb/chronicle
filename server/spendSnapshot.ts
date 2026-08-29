/**
 * The briefing runner's spend slice (CHI-324 2i). Closes the D7 gap: the phase-1
 * briefing shipped NON-SPEND cards only because the spend detector was not yet
 * server-side. It is now — this module reuses the SAME pieces the Overview
 * anomaly tile and Spend tab run on, so the briefing can never disagree with
 * them:
 *
 *   computeActivity (server/activity.ts) → burn.anomalyDays (per-day per-dimension
 *   token CELLS) → priced here at each day's own rate via costOf (shared/pricing.ts,
 *   the ONE price table) → CostedDay[] → computeAnomaly / computeFlaggedDays
 *   (shared/spend/anomaly.ts, the ONE algorithm).
 *
 * This is a faithful server-side port of the client's buildCostedDays
 * (src/insights/anomalyMath.ts): same day-rate pricing (CHI-228), same Lane-C
 * fold (proxy spend into the day TOTAL only, never a dimension — D8). The runner
 * prices at the fixed THEORETICAL (list-price) basis, matching Varde's anomaly
 * math; the client re-prices at the toggled mode with no server round-trip, so
 * no server-side dollar math ever reaches an API response (the sanctioned
 * headless-runner exception, same as the briefing/ask runners).
 *
 * BUDGET (CHI-366): the monthly budget now has a server-visible home
 * (`monthlyBudget` in ~/.chronicle/config.json, read here via readConfig), so the
 * runner emits a budget-posture card off the SAME computeBudgetPosture the Spend
 * tab uses. One subtlety the two must agree on: the Spend tab's BudgetBand
 * computes month-to-date from `insights.dailySpend`, which is bucketedUsage only
 * — Lane C (proxy-lane $) is a SEPARATE field there and is NOT in the budget MTD.
 * So the budget slice prices a LANE-C-FREE costed-day series (unlike the anomaly
 * reading, which folds Lane C into the day total on purpose). Getting this wrong
 * would make the server budget read higher than the Spend tab's by the proxy
 * total — exactly the disagreement this move is meant to prevent.
 */
import { computeActivity, type ActivityBurn, type TokensByModel } from './activity.ts';
import { costOf } from '../shared/pricing.ts';
import {
  computeAnomaly,
  computeFlaggedDays,
  type AnomalyResult,
  type CostedDay,
  type FlaggedDay,
} from '../shared/spend/anomaly.ts';
import { computeBudgetPosture, type BudgetPosture } from '../shared/spend/budget.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';
import { readConfig } from './autosync.ts';

// Price a bag of per-model token cells at a SPECIFIC day's rate (CHI-228), at the
// fixed theoretical basis. Mirrors anomalyMath.ts priceCellsAtDay.
function priceCellsAtDay(byModel: TokensByModel, day: string): number {
  let total = 0;
  for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell, day, 'theoretical') ?? 0;
  return total;
}

/** The costed day series the shared spend math runs over, built from the server
 * burn cells. Faithful port of src/insights/anomalyMath.ts buildCostedDays at
 * the theoretical basis: each day priced at its own rate, per dimension
 * (model/project/source), Lane C folded into the day TOTAL only (D8). */
export function costedDaysFromBurn(burn: ActivityBurn, includeLaneC = true): CostedDay[] {
  return burn.anomalyDays.map((d) => {
    const byDimension = {
      model: Object.fromEntries(Object.entries(d.byModel).map(([m, cell]) => [m, priceCellsAtDay({ [m]: cell }, d.day)])),
      project: Object.fromEntries(Object.entries(d.byProject).map(([p, cells]) => [p, priceCellsAtDay(cells, d.day)])),
      source: Object.fromEntries(Object.entries(d.bySource).map(([s, cells]) => [s, priceCellsAtDay(cells, d.day)])),
    };
    // Lane C folds into the day TOTAL for the anomaly reading (D8), but NOT for
    // the budget slice — the Spend tab's budget MTD excludes it (see file header).
    const laneC = includeLaneC ? (burn.laneCByDay[d.day] ?? 0) : 0;
    return { day: d.day, cost: priceCellsAtDay(d.byModel, d.day) + laneC, byDimension };
  });
}

/** The spend slice the briefing snapshot carries. `today` is the LOCAL anchor
 * computeAnomaly compares against; `anomaly` is the full anomaly reading (ratio,
 * flagged/escalated, top movers, Lane-C inclusion); `flaggedDays` are the
 * per-day spikes across the whole series (newest first). */
export interface SpendSnapshot {
  today: string;
  anomaly: AnomalyResult;
  flaggedDays: FlaggedDay[];
  /** Monthly budget posture (CHI-366) priced Lane-C-free, matching the Spend
   * tab's BudgetBand. `state` is null when no monthly budget is configured, in
   * which case the briefing emits no budget card. */
  budget: BudgetPosture;
}

/** The configured monthly budget (USD), or null. Read from the same config the
 * /settings route writes, so the runner and the Spend tab never disagree. */
function readMonthlyBudget(): number | null {
  const raw = readConfig().monthlyBudget;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Assemble the briefing spend slice from the live DB. Never throws on an empty
 * DB (a fresh machine has no sessions → an all-quiet anomaly reading). */
export function buildSpendSnapshot(_now: Date = new Date()): SpendSnapshot {
  const { burn } = computeActivity(null, null); // All window → every day of history
  const days = costedDaysFromBurn(burn);
  const includesLaneC = Object.values(burn.laneCByDay).some((v) => v > 0);
  const anomaly = computeAnomaly(days, burn.today, DEFAULT_SPEND_THRESHOLDS.anomaly, { includesLaneC });
  const flaggedDays = computeFlaggedDays(days, burn.today);
  // Budget posture over a LANE-C-FREE series (see costedDaysFromBurn / header),
  // priced at the theoretical basis like the rest of the snapshot.
  const budget = computeBudgetPosture(costedDaysFromBurn(burn, false), burn.today, readMonthlyBudget());
  return { today: burn.today, anomaly, flaggedDays, budget };
}
