// shared/spend/anomaly.ts
// Spend anomaly detection, ported from Varde aggregator/sources/spend.ts
// computeAnomaly (CHI-324 2a / D4). Pure over ALREADY-COSTED day series, so it
// is pricing-agnostic: the caller prices token cells with its own PriceFn (the
// client at the toggled mode, the server at the theoretical basis)
// and hands this dollars. ONE algorithm, no second pricing path.
//
// Baseline = median cost of the trailing `windowDays` ACTIVE days (cost > 0)
// strictly before `today`. Flag when today's cost exceeds `multiplier`x that
// median; escalate past `escalation`x. The same rule runs per dimension value
// against its own trailing median, floored at `dimFlagFloorUsd` so sub-dollar
// noise never "moves". Relative-import value module (never @shared), B3.

import type { AnomalyThresholds, SpendThresholds } from './thresholds.ts';
import { DEFAULT_SPEND_THRESHOLDS } from './thresholds.ts';

// Anomaly mover dimensions, named in Chronicle's vocabulary (source = tool
// vendor claude-code/codex/…, the faithful port of Varde's byClient; mcp from
// the dormant mcp_server column; agent = agent_type).
export type AnomalyDimension = 'model' | 'project' | 'source' | 'skill' | 'agent' | 'mcp';
export const ANOMALY_DIMENSIONS: AnomalyDimension[] = ['model', 'project', 'source', 'skill', 'agent', 'mcp'];
const DIM_LABEL: Record<AnomalyDimension, string> = {
  model: 'model', project: 'project', source: 'source', skill: 'skill', agent: 'agent', mcp: 'mcp',
};

// One day's total cost + optional per-dimension cost, ALL in dollars (already
// priced by the caller). `byDimension[dim][value] = costUsd`.
export interface CostedDay {
  day: string; // YYYY-MM-DD (local)
  cost: number;
  byDimension?: Partial<Record<AnomalyDimension, Record<string, number>>>;
}

export interface DimensionFlag {
  dimension: string;
  value: string;
  todayCost: number;
  medianCost: number;
  ratio: number;
}

export interface AnomalyResult {
  baselineMedian: number | null; // null when there is no prior active day
  todayCost: number;
  ratio: number | null;
  flagged: boolean;
  escalated: boolean;
  threshold: number; // = multiplier, for the tip
  windowDays: number;
  benchmarkPerDay: number;
  dimensionFlags: DimensionFlag[]; // top 10 by todayCost
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

// One prior day in the current window that was itself a spend spike (its own
// cost > multiplier x the median of the active days strictly before it). Feeds
// the anomaly tile's "N flagged days" line on multi-day windows (CHI-324 2c).
export interface FlaggedDay {
  day: string;
  cost: number;
  median: number;
  ratio: number;
}

// Days in the window that flagged as anomalies vs their OWN trailing median,
// newest first. `today` is excluded (it is the headline ratio, not a window
// flag). `sinceDay` (inclusive) bounds which days are REPORTED — each day's
// median still looks back across the full `days` series, so a flag near the
// window start still has a real baseline. Pure over already-costed days, same
// as computeAnomaly.
export function computeFlaggedDays(
  days: CostedDay[],
  today: string,
  thresholds: AnomalyThresholds = DEFAULT_SPEND_THRESHOLDS.anomaly,
  sinceDay?: string,
): FlaggedDay[] {
  const { multiplier, windowDays } = thresholds;
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const out: FlaggedDay[] = [];
  for (const d of sorted) {
    if (d.day >= today || d.cost <= 0) continue;
    if (sinceDay && d.day < sinceDay) continue;
    const prior = sorted.filter((x) => x.day < d.day && x.cost > 0).slice(-windowDays);
    if (!prior.length) continue;
    const m = median(prior.map((x) => x.cost));
    if (m > 0 && d.cost / m > multiplier) {
      out.push({ day: d.day, cost: round2(d.cost), median: round2(m), ratio: round2(d.cost / m) });
    }
  }
  return out.reverse(); // newest first
}

export function computeAnomaly(
  days: CostedDay[],
  today: string,
  thresholds: AnomalyThresholds = DEFAULT_SPEND_THRESHOLDS.anomaly,
): AnomalyResult {
  const { multiplier, escalation, windowDays, benchmarkPerDay, dimFlagFloorUsd } = thresholds;
  const prior = days.filter((d) => d.day < today && d.cost > 0).slice(-windowDays);
  const todayRow = days.find((d) => d.day === today);
  const todayCost = todayRow?.cost ?? 0;
  const baselineMedian = prior.length ? median(prior.map((d) => d.cost)) : null;
  const ratio = baselineMedian ? todayCost / baselineMedian : null;

  const dimensionFlags: DimensionFlag[] = [];
  if (todayRow && prior.length) {
    for (const dim of ANOMALY_DIMENSIONS) {
      const todayDim = todayRow.byDimension?.[dim] ?? {};
      for (const [value, cost] of Object.entries(todayDim)) {
        if (cost < dimFlagFloorUsd) continue;
        const hist = prior.map((d) => d.byDimension?.[dim]?.[value] ?? 0).filter((c) => c > 0);
        if (!hist.length) continue;
        const m = median(hist);
        if (m > 0 && cost / m > multiplier) {
          dimensionFlags.push({ dimension: DIM_LABEL[dim], value, todayCost: round2(cost), medianCost: round2(m), ratio: round2(cost / m) });
        }
      }
    }
  }
  dimensionFlags.sort((a, b) => b.todayCost - a.todayCost);

  return {
    baselineMedian: baselineMedian === null ? null : round2(baselineMedian),
    todayCost: round2(todayCost),
    ratio: ratio === null ? null : round2(ratio),
    flagged: ratio !== null && ratio > multiplier,
    escalated: ratio !== null && ratio > escalation,
    threshold: multiplier,
    windowDays,
    benchmarkPerDay,
    dimensionFlags: dimensionFlags.slice(0, 10),
  };
}
