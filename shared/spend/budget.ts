// shared/spend/budget.ts
// Monthly budget posture, ported from Varde's SpendPage month math (CHI-324
// 2a / D5): month-to-date, $/day pace, month-end projection, budget share +
// graded state. Pure over already-costed day series (dollars), pricing-agnostic
// like anomaly.ts. Relative-import value module (never @shared), B3.

import type { BudgetThresholds } from './thresholds.ts';
import { DEFAULT_SPEND_THRESHOLDS, gradeBudget, type StateWord } from './thresholds.ts';
import type { CostedDay } from './anomaly.ts';

export interface BudgetPosture {
  /** null when no budget is set — the console reports "no cap set", never a
   * share against a number you never chose (Varde's shipped default). */
  monthlyUsd: number | null;
  monthToDate: number;
  /** $/day so far this month = monthToDate / elapsed days. */
  perDayPace: number;
  /** Projected month-end spend = pace x days-in-month; null when too few days
   * have elapsed for a projection to be anything but noise. */
  projected: number | null;
  /** monthToDate / budget, or null when no budget is set. */
  share: number | null;
  /** graded word ("on track" / "approaching" / "over budget"), or null. */
  state: StateWord | null;
  /** days elapsed in the month through `today` (inclusive). */
  elapsedDays: number;
  daysInMonth: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// days in the calendar month of `today` (YYYY-MM-DD). Explicit-arg Date only
// (never argless — safe outside Workflow scripts; this is normal runtime code).
function daysInMonthOf(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate(); // month1 is 1-based; day 0 = last of prev = last of month1
}

export function computeBudgetPosture(
  days: CostedDay[],
  today: string, // YYYY-MM-DD (local)
  monthlyUsd: number | null,
  thresholds: BudgetThresholds = DEFAULT_SPEND_THRESHOLDS.budget,
): BudgetPosture {
  const [yStr, mStr, dStr] = today.split('-');
  const year = Number(yStr);
  const month1 = Number(mStr); // 1-based
  const elapsedDays = Number(dStr); // day-of-month through today, inclusive
  const daysInMonth = daysInMonthOf(year, month1);
  const monthPrefix = `${yStr}-${mStr}-`;

  const monthToDate = round2(
    days.filter((d) => d.day.startsWith(monthPrefix) && d.day <= today)
      .reduce((s, d) => s + d.cost, 0),
  );

  const perDayPace = elapsedDays > 0 ? round2(monthToDate / elapsedDays) : 0;
  const projected = elapsedDays >= thresholds.minDaysForProjection
    ? round2(perDayPace * daysInMonth)
    : null;

  const share = monthlyUsd && monthlyUsd > 0 ? monthToDate / monthlyUsd : null;
  const state = share === null ? null : gradeBudget(share, thresholds);

  return {
    monthlyUsd,
    monthToDate,
    perDayPace,
    projected,
    share: share === null ? null : round2(share),
    state,
    elapsedDays,
    daysInMonth,
  };
}
