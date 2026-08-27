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
 * BUDGET (deferred, CHI-355 follow-up): the monthly budget lives only in the
 * client's localStorage (`chronicle.monthlyBudget`), so the runner has no honest
 * server-visible source for a budget-posture card. It ships the spend-anomaly
 * card only until the budget moves server-side; then computeBudgetPosture slots
 * in the same way.
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
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';

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
export function costedDaysFromBurn(burn: ActivityBurn): CostedDay[] {
  return burn.anomalyDays.map((d) => {
    const byDimension = {
      model: Object.fromEntries(Object.entries(d.byModel).map(([m, cell]) => [m, priceCellsAtDay({ [m]: cell }, d.day)])),
      project: Object.fromEntries(Object.entries(d.byProject).map(([p, cells]) => [p, priceCellsAtDay(cells, d.day)])),
      source: Object.fromEntries(Object.entries(d.bySource).map(([s, cells]) => [s, priceCellsAtDay(cells, d.day)])),
    };
    const laneC = burn.laneCByDay[d.day] ?? 0;
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
}

/** Assemble the briefing spend slice from the live DB. Never throws on an empty
 * DB (a fresh machine has no sessions → an all-quiet anomaly reading). */
export function buildSpendSnapshot(_now: Date = new Date()): SpendSnapshot {
  const { burn } = computeActivity(null, null); // All window → every day of history
  const days = costedDaysFromBurn(burn);
  const includesLaneC = Object.values(burn.laneCByDay).some((v) => v > 0);
  const anomaly = computeAnomaly(days, burn.today, DEFAULT_SPEND_THRESHOLDS.anomaly, { includesLaneC });
  const flaggedDays = computeFlaggedDays(days, burn.today);
  return { today: burn.today, anomaly, flaggedDays };
}
