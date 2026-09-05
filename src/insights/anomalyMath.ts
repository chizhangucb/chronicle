// Client-side anomaly helpers shared by the Overview AnomalyTile and the Spend
// tab's Anomaly card (CHI-324 2c/2b), so the two anomaly views compute
// identically. Pricing happens here (the price table is client-only); the pure
// algorithm lives in shared/spend/anomaly.ts. Prices every day at its own rate
// (CHI-228) and honors the List/Billed toggle.
import { costOf, type CostMode } from '../models.js';
import type { ActivityResult, ActivityTokensByModel } from '../api.js';
import type { CostedDay, AnomalyDimension, FlaggedDay } from '../../shared/spend/anomaly.ts';
import { computeFlaggedDays } from '../../shared/spend/anomaly.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../../shared/spend/thresholds.ts';

// Mono glyph per anomaly-mover dimension (design-QA rubric vocabulary; the D3
// artifact approved ◫ project + ▤ model). Only model/project/source ever ship
// as movers (server/activity.ts anomalyDays cells); the rest are future-safe.
export const MOVER_GLYPH: Record<AnomalyDimension, string> = {
  project: '◫', model: '▤', source: '◇', skill: '✎', agent: '⛭', mcp: '⧉',
};

// Price a bag of per-model token cells at a SPECIFIC day's rate (CHI-228).
export function priceCellsAtDay(byModel: ActivityTokensByModel, day: string, mode: CostMode): number {
  let total = 0;
  for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell, day, mode) ?? 0;
  return total;
}

// Build the costed day series the shared spend math runs over: each server day
// cell priced at the toggled mode AND at its own day's rate, per-dimension
// (model/project/source).
export function buildCostedDays(burn: ActivityResult['burn'], mode: CostMode): CostedDay[] {
  return burn.anomalyDays.map((d) => {
    const byDimension: Partial<Record<AnomalyDimension, Record<string, number>>> = {
      model: Object.fromEntries(Object.entries(d.byModel).map(([m, cell]) => [m, priceCellsAtDay({ [m]: cell }, d.day, mode)])),
      project: Object.fromEntries(Object.entries(d.byProject).map(([p, cells]) => [p, priceCellsAtDay(cells, d.day, mode)])),
      source: Object.fromEntries(Object.entries(d.bySource).map(([s, cells]) => [s, priceCellsAtDay(cells, d.day, mode)])),
    };
    return { day: d.day, cost: priceCellsAtDay(d.byModel, d.day, mode), byDimension };
  });
}

// The window's inclusive start day (YYYY-MM-DD, local) — `today` minus (days-1).
// Null for the All window (no bound).
export function windowStartDay(today: string, days: number | null): string | null {
  if (days == null) return null;
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(y, m - 1, d - (Math.max(Math.round(days), 1) - 1));
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}

// The ONE window-scoped anomaly view, shared verbatim by the Overview tile and
// the Spend-tab card so the two surfaces can NEVER disagree (CHI-324 review —
// they showed different All totals, and 90d > All, because they read different,
// differently-bounded sources). Everything here derives from burn.anomalyDays,
// which the server now sizes to cover the FULL window + a 14-day baseline for
// every window. `current` = window sum; `ratio` = current / server prior-period
// baseline; movers = top project + top model by window spend; flaggedDays =
// per-day spikes in the window.
export interface WindowAnomaly {
  current: number;
  baseline: number;
  hasBaseline: boolean;
  ratio: number | null;
  hot: boolean;
  topProject: { value: string; cost: number } | null;
  topModel: { value: string; cost: number } | null;
  flaggedDays: FlaggedDay[];
}

export function windowAnomaly(burn: ActivityResult['burn'], mode: CostMode, days: number | null): WindowAnomaly {
  const costedDays = buildCostedDays(burn, mode);
  const winStart = windowStartDay(burn.today, days);
  const inWindow = (day: string) => (winStart ? day >= winStart : true) && day <= burn.today;
  const current = costedDays.filter((d) => inWindow(d.day)).reduce((s, d) => s + d.cost, 0);
  let baseline = 0;
  for (const [model, cell] of Object.entries(burn.baselineTokensByModel)) baseline += costOf(model, cell, undefined, mode) ?? 0;
  const hasBaseline = baseline > 0;
  const ratio = hasBaseline ? current / baseline : null;
  return {
    current,
    baseline,
    hasBaseline,
    ratio,
    hot: ratio != null && ratio > 2,
    topProject: topDimInWindow(costedDays, burn.today, winStart, 'project'),
    topModel: topDimInWindow(costedDays, burn.today, winStart, 'model'),
    flaggedDays: computeFlaggedDays(costedDays, burn.today, DEFAULT_SPEND_THRESHOLDS.anomaly, winStart ?? undefined),
  };
}

// The top value of one dimension by absolute spend within [start, today]
// (start === null → the whole series, the All window). Window-scoped, so the
// movers move as the window changes.
export function topDimInWindow(days: CostedDay[], today: string, start: string | null, dim: AnomalyDimension): { value: string; cost: number } | null {
  const totals = new Map<string, number>();
  for (const d of days) {
    if (d.day > today || (start && d.day < start)) continue;
    for (const [value, cost] of Object.entries(d.byDimension?.[dim] ?? {})) totals.set(value, (totals.get(value) ?? 0) + cost);
  }
  let best: { value: string; cost: number } | null = null;
  for (const [value, cost] of totals) if (!best || cost > best.cost) best = { value, cost };
  return best && best.cost > 0 ? { value: best.value, cost: Math.round(best.cost * 100) / 100 } : null;
}
