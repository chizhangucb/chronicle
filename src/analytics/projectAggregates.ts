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
import { dayKeyOf } from '../charts/timeBuckets.ts';
import { costOfBucketedCells, groupByKey, sumByModel } from '../rangedUsage.ts';

// The result types live here, not in shared/: the server computes none of
// these shapes, so a shared/ declaration would falsely imply a cross-boundary
// contract.

/** What the Overview renders for one project, in the shape it maps to JSX. */
export interface ProjectAggregates {
  toolCalls: number;
  messages: number;
  userPrompts: number;
  errors: number;
  /** Errors as a percentage of tool calls (0 when there were none). */
  errorRate: number;
  activeDays: number;
  /** Agent-active time across the listed sessions. */
  activeMs: number;
  totalCost: number;
  totalIn: number;
  totalOut: number;
  /** Input + output, the same "Tokens" definition every other surface uses. */
  totalTokens: number;
  modelCount: number;
}

// One session's agent-active time: the stored figure when the importer
// computed one (shared/durations.ts), else wall-clock start→end. Exported
// because the project page's session-list "duration" sort orders by the very
// same number — one rule, read by the KPI here and by that sort, rather than
// a twin on each side.
export function sessionAgentActiveMs(s: ProjectSessionSummary): number {
  return s.agent_active_ms
    ?? (s.started_at && s.ended_at ? +new Date(s.ended_at) - +new Date(s.started_at) : 0);
}

export function projectAggregates(data: ProjectDetailResult, mode: CostMode = 'theoretical'): ProjectAggregates {
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
  let totalIn = 0, totalOut = 0, totalCost = 0;
  for (const [model, cell] of byModel) {
    totalIn += cell.input;
    totalOut += cell.output;
    // Per model, then per day-bucket: a model's cells spanning a rate change
    // (e.g. Sonnet 5's intro window) must not collapse to one flat rate.
    totalCost += costOfBucketedCells(cellsByModel.get(model) ?? [], mode);
  }

  const startDays = new Set<string>();
  let activeMs = 0;
  for (const s of sessions) {
    activeMs += sessionAgentActiveMs(s);
    if (s.started_at) startDays.add(dayKeyOf(new Date(s.started_at)));
  }

  return {
    toolCalls,
    messages,
    userPrompts,
    errors,
    errorRate: toolCalls ? (errors / toolCalls) * 100 : 0,
    activeDays: startDays.size,
    activeMs,
    totalCost,
    totalIn,
    totalOut,
    totalTokens: totalIn + totalOut,
    modelCount: byModel.size,
  };
}
