// Client-side aggregation over the windowed usage cells server/windowUsage.ts
// computes (Task 2) and `/api/insights` + `/api/projects/:id` now return
// (Task 3) — `windowedTokensByModel` / `dailySpend` / `hourlySpend`. These
// replace summing raw `sessions.usage` per session, so a session that started
// before the active window but ran INTO it contributes only its in-window
// share everywhere (KPI strip, spend-by-model, token table, top sessions,
// spend-over-time chart), instead of either vanishing or being counted at its
// full historical total.
//
// The price table lives ONLY in src/models.ts (CLAUDE.md hard constraint) —
// this module aggregates token CELLS; callers price them via `costOf`. A
// group's per-model breakdown is always preserved until the moment of
// pricing (never flatten different models' tokens into one bag first) since
// each model has its own $/token rate.
import { costOf, type ModelUsageInput } from './models.ts';

export interface UsageCell {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface WindowedCell {
  sessionId: string;
  projectId: number;
  model: string;
  source: string;
  cells: UsageCell;
}

export interface BucketedCell extends WindowedCell {
  bucket: string;
}

function emptyCell(): UsageCell {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}
function addCell(a: UsageCell, b: UsageCell): UsageCell {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

// Sums cells into ONE UsageCell per model, ignoring every other dimension
// (session/project/source/bucket) — used wherever the model IS the group
// (Spend by model, the Token usage by model table).
export function sumByModel<T extends WindowedCell>(cells: T[]): Map<string, UsageCell> {
  const out = new Map<string, UsageCell>();
  for (const c of cells) out.set(c.model, addCell(out.get(c.model) ?? emptyCell(), c.cells));
  return out;
}

// Sums cells into a per-model UsageCell for each `keyOf` group (project,
// session, bucket, …) — kept two-level (key → model → cell) so a group
// spanning multiple models can still be priced correctly per model before
// summing (see the header comment: never flatten across models pre-price).
export function sumByKeyModel<T extends WindowedCell>(cells: T[], keyOf: (c: T) => string): Map<string, Map<string, UsageCell>> {
  const out = new Map<string, Map<string, UsageCell>>();
  for (const c of cells) {
    let byModel = out.get(keyOf(c));
    if (!byModel) { byModel = new Map(); out.set(keyOf(c), byModel); }
    byModel.set(c.model, addCell(byModel.get(c.model) ?? emptyCell(), c.cells));
  }
  return out;
}

// Splits a bucketed cell list into one raw cell list per bucket key —
// callers then apply sumByModel/sumByKeyModel to each bucket's slice (e.g.
// grouping the Home spend-over-time chart's per-bucket cells by project).
export function groupByBucket<T extends BucketedCell>(cells: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of cells) {
    const arr = out.get(c.bucket);
    if (arr) arr.push(c); else out.set(c.bucket, [c]);
  }
  return out;
}

// Prices a per-model cell map: each model's cell is priced at ITS OWN rate
// (never summed across models first — see header comment) via costOf, then
// totalled. Unpriced models (costOf returns null) contribute 0.
export function costOfCells(byModel: Map<string, UsageCell> | undefined): number {
  if (!byModel) return 0;
  let total = 0;
  for (const [model, cell] of byModel) total += costOf(model, cell as ModelUsageInput) ?? 0;
  return total;
}

// input + output tokens across every model in a per-model cell map — the
// same "Tokens" definition used elsewhere (cache tokens are a separate
// billing tier, shown in their own columns).
export function tokensOfCells(byModel: Map<string, UsageCell> | undefined): number {
  if (!byModel) return 0;
  let total = 0;
  for (const cell of byModel.values()) total += cell.input + cell.output;
  return total;
}

// Flattens a per-model cell map into ONE combined cell, ignoring model
// identity — safe ONLY for raw (unpriced) field totals like input/cacheRead
// counts (e.g. the KPI strip's cached % ), never for cost (see header).
export function sumFields(byModel: Map<string, UsageCell> | undefined): UsageCell {
  const out = emptyCell();
  if (!byModel) return out;
  let acc = out;
  for (const cell of byModel.values()) acc = addCell(acc, cell);
  return acc;
}
