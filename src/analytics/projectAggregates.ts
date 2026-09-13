// The project Overview's numbers, in one plain function (#376).
//
// The page used to assemble them inside its own `useMemo`, so a KPI
// definition ("Tokens" is input + output, cost is priced per day and model)
// was written once per surface and could drift from the Insights home's
// answer for the identical cells. This module is the one home for the
// project scope's assembly; `homeAggregates` and `sessionAggregates` are the
// same pattern and follow later. The name mirrors the server's
// `computeScopedAggregates`.
//
// The server ships tokens and this prices them (ADR 0005): every dollar here
// goes through the ranged-usage primitives in src/rangedUsage.ts, which price
// each model's cells at that model's rate for that cell's own local day.
//
// Executed directly by node (test/project-aggregates.test.mjs imports it as
// `.ts`, and node's strip-only loader takes specifiers literally), so every
// import below points at the real `.ts` file, never `.js`.
import type { CostMode } from '../models.ts';
import type { ProjectDetailResult } from '../../shared/results.ts';
import type { ProjectSessionSummary } from '../../shared/rows.ts';
import { densifyBuckets, dayKeyOf } from '../charts/timeBuckets.ts';
import { friendlyToolLabel } from '../toolLabels.ts';
import { costOfCells, costOfBucketedCells, groupByBucket, groupByKey, sumByModel } from '../rangedUsage.ts';

// How many rows the ranking and the cost-by-model bars cut to: both cards
// render a fixed-height bar list, so a long tail would push the page around
// rather than tell the operator anything.
const TOP_N = 8;
// A label longer than this has no room in a bar row, so it lands in the
// ranking's one aggregate row instead of blowing the row out. The gate reads
// the LABEL, so a renamed tool keeps its friendly name whatever its raw name
// was (every mapped label is short by construction).
const MAX_LABEL_LEN = 18;

// The result types live here, not in shared/: the server computes none of
// these shapes, so a shared/ declaration would falsely imply a cross-boundary
// contract.

// One local calendar day of the spend-over-time chart. Not exported: it is
// reachable through `ProjectAggregates['trend']`, and an export nothing
// imports reads as an interface (test/exports-have-callers.test.mjs).
interface ProjectTrendPoint {
  /** Local day key, `YYYY-MM-DD` (src/charts/timeBuckets.ts). */
  day: string;
  /** Sessions STARTED that day — a session is begun once, so it is counted once. */
  count: number;
  /** Dollars billed that day, from that day's cells at that day's rate. */
  cost: number;
}

/** What the Overview renders for one project, in the shape it maps to JSX. */
export interface ProjectAggregates {
  toolCalls: number;
  messages: number;
  userPrompts: number;
  errors: number;
  /** Errors as a percentage of tool calls (0 when there were none). */
  errorRate: number;
  activeDays: number;
  /** Time the listed sessions ran, summed (see `sessionDurationMs`). */
  activeMs: number;
  totalCost: number;
  totalIn: number;
  totalOut: number;
  /** Input + output, the same "Tokens" definition every other surface uses. */
  totalTokens: number;
  modelCount: number;
  /** Dollars per model, desc, top `TOP_N`. */
  costByModel: [string, number][];
  /** Tool calls per friendly label (user prompts included), desc, top `TOP_N`. */
  ranking: [string, number][];
  /** Sessions per source, desc. */
  sources: [string, number][];
  /** Spend over time, one point per local day, dense-filled across idle days. */
  trend: ProjectTrendPoint[];
}

// How long one session ran: the agent-active time the importer computed when
// there is one (shared/durations.ts, summed from message gaps), else
// wall-clock start→end. The fallback is NOT agent-active time in CONTEXT.md's
// sense, so the helper is named for the wider thing it actually returns.
// Exported because the project page's session-list "duration" sort orders by
// this very number — one rule read by both, rather than a twin on each side.
export function sessionDurationMs(s: ProjectSessionSummary): number {
  return s.agent_active_ms
    ?? (s.started_at && s.ended_at ? +new Date(s.ended_at) - +new Date(s.started_at) : 0);
}

// Highest first, cut to the bar list's row budget. Ties keep insertion order
// (Array#sort is stable), so a redraw cannot reshuffle equal rows.
function topN(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
}

// `mode` is the selected cost basis and has no default: which price a dollar
// figure is computed at is the caller's decision, never a silent one.
export function projectAggregates(data: ProjectDetailResult, mode: CostMode): ProjectAggregates {
  const { sessions, analytics } = data;
  const toolCalls = analytics.kindDist.find((k) => k.kind === 'tool_use')?.count ?? 0;
  const messages = analytics.kindDist.reduce((n, k) => n + k.count, 0);
  const userPrompts = analytics.kindDist.find((k) => k.kind === 'user')?.count ?? 0;
  const errors = analytics.errors || 0;

  // Cost and tokens come off the ranged cells, never raw `sessions.usage`: a
  // session that started before the range but ran INTO it contributes only
  // its in-range share, so these KPIs agree with the session list (already
  // overlap-gated server-side) at every window.
  const byModel = sumByModel(analytics.rangedTokensByModel);
  const cellsByModel = groupByKey(analytics.rangedTokensByModel, (c) => c.model);
  let totalIn = 0, totalOut = 0;
  const costByModelMap = new Map<string, number>();
  for (const [model, cell] of byModel) {
    totalIn += cell.input;
    totalOut += cell.output;
    // Per model, then per day-bucket: a model's cells spanning a rate change
    // (e.g. Sonnet 5's intro window) must not collapse to one flat rate.
    costByModelMap.set(model, costOfBucketedCells(cellsByModel.get(model) ?? [], mode));
  }

  const sessionsByDay = new Map<string, number>();
  const bySource = new Map<string, number>();
  let activeMs = 0;
  for (const s of sessions) {
    activeMs += sessionDurationMs(s);
    if (s.started_at) {
      const day = dayKeyOf(new Date(s.started_at));
      sessionsByDay.set(day, (sessionsByDay.get(day) ?? 0) + 1);
    }
    bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
  }

  // Spend over time, from the per-session, per-model, per-LOCAL-day cells the
  // route already ships: each day's cells are priced at THAT day's rate, so a
  // session that ran across midnight (or across a model's rate change)
  // contributes to each day it actually ran, and the chart agrees with the
  // Insights home for the identical cells. The page used to attribute a
  // whole session's cost to the day it started on.
  const costByDay = new Map<string, number>();
  let totalCost = 0;
  for (const [day, group] of groupByBucket(analytics.rangedTokensByModel)) {
    const cost = costOfCells(sumByModel(group), day, mode);
    costByDay.set(day, cost);
    // The Cost KPI is the sum of the days the chart draws, not a second
    // derivation of the same dollars: the headline can never disagree with
    // the bars under it. The cost-by-model split is the same money grouped
    // the other way, pinned by its own test.
    totalCost += cost;
  }
  // Dense-filled from the first to the last day with anything on it, so equal
  // bar spacing always reads as equal time. A day can carry a session with no
  // billed cells, or billed cells from a session that started earlier, so the
  // span covers both key sets.
  const trend: ProjectTrendPoint[] = densifyBuckets([...sessionsByDay.keys(), ...costByDay.keys()], 'day')
    .map((day) => ({ day, count: sessionsByDay.get(day) ?? 0, cost: costByDay.get(day) ?? 0 }));

  // Tool calls by friendly label (src/toolLabels.ts, the same names the
  // session Overview uses), with the operator's own prompts as a row of the
  // same ranking — two names mapping to one label merge into one row.
  const ranked = new Map<string, number>();
  for (const d of analytics.toolDist) {
    const label = friendlyToolLabel(d.name || '');
    const row = label.length > MAX_LABEL_LEN ? 'Other' : label;
    ranked.set(row, (ranked.get(row) ?? 0) + d.count);
  }
  if (userPrompts) ranked.set('User Prompt', userPrompts);

  return {
    toolCalls,
    messages,
    userPrompts,
    errors,
    errorRate: toolCalls ? (errors / toolCalls) * 100 : 0,
    // Days with at least one session started: the same day keys the trend
    // counts on, so the KPI and the chart's line cannot disagree.
    activeDays: sessionsByDay.size,
    activeMs,
    totalCost,
    totalIn,
    totalOut,
    totalTokens: totalIn + totalOut,
    modelCount: byModel.size,
    costByModel: topN(costByModelMap),
    ranking: topN(ranked),
    sources: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    trend,
  };
}
