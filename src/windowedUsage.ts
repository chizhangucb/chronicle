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
import { costOf, type ModelUsageInput, type CostMode } from './models.ts';

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
// totalled. Unpriced models (costOf returns null) contribute 0. `day`
// (YYYY-MM-DD) resolves a date-dependent rate (e.g. Sonnet 5's CHI-228 intro
// window) for callers that already know every cell in this map shares one
// day; omit it for the latest/current rate.
export function costOfCells(byModel: Map<string, UsageCell> | undefined, day?: string | null, mode: CostMode = 'theoretical'): number {
  if (!byModel) return 0;
  let total = 0;
  for (const [model, cell] of byModel) total += costOf(model, cell as ModelUsageInput, day, mode) ?? 0;
  return total;
}

// Splits a cell list into one raw list per arbitrary key (project id, session
// id, …) — generalizes groupByBucket to any grouping, not just bucket.
export function groupByKey<T extends WindowedCell>(cells: T[], keyOf: (c: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of cells) {
    const arr = out.get(keyOf(c));
    if (arr) arr.push(c); else out.set(keyOf(c), [c]);
  }
  return out;
}

// Total $ across a day-bucketed cell list, pricing EACH bucket at its own
// day (never the whole list at one flat rate) — the fix for CHI-228: a
// session's usage that straddles a rate change (e.g. Sonnet 5's intro window)
// must be split and priced per bucket, then summed, not collapsed first. Compose
// with groupByKey for a per-key total that still prices correctly per day
// (e.g. costOfBucketedCells(groupByKey(cells, keyOf).get(key) ?? [])).
export function costOfBucketedCells<T extends BucketedCell>(cells: T[], mode: CostMode = 'theoretical'): number {
  let total = 0;
  for (const [day, group] of groupByBucket(cells)) total += costOfCells(sumByModel(group), day, mode);
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

// ---- Automation split (CHI-233 Part C) ----
// Chronicle counts sessions from scanned transcripts. The machine-session
// manifest (~/.aios/machine_sessions.jsonl) lists headless AUTOMATION spawns.
// This splits the in-window sessions into an INTERACTIVE count (the headline
// number, manifest ids excluded) and an AUTOMATION bucket (attributed by job),
// pricing each so automation spend is separable but still part of the total.
//
// CRITICAL dedup rule: a manifest session whose transcript IS present in the
// scan is priced from the transcript (its windowed cells), NOT the manifest
// snapshot — transcript wins, never double count. A manifest session with no
// transcript (reaped session-close) is priced from its manifest usage cells via
// costOf. Every in-window session lands in exactly one of: interactive,
// automation-present, automation-absent.

// A manifest session as the client consumes it (mirrors api.ts MachineSession).
export interface MachineSessionInput {
  sessionId: string;
  job: string;
  model: string | null;
  usage: UsageCell;
  cost_usd: number | null;
  ts: string | null;
}

export interface AutomationJobBucket {
  job: string;
  sessions: number;
  cost: number;
}

export interface AutomationSplit {
  // Headline number: scanned sessions that are NOT automation.
  interactiveSessionCount: number;
  // Manifest sessions in range (present-with-transcript + absent), deduped.
  automationSessionCount: number;
  // Total automation spend (present priced from transcripts, absent from the
  // manifest cells) — priced at `mode`, so 0 under "real" for covered models.
  automationCost: number;
  byJob: AutomationJobBucket[];
}

export function splitAutomation(
  sessions: { id: string }[],
  windowedCells: BucketedCell[],
  machine: { ids: string[]; sessions: MachineSessionInput[] },
  mode: CostMode = 'theoretical',
): AutomationSplit {
  const manifestIds = new Set(machine.ids);
  const dbIds = new Set(sessions.map((s) => s.id));
  const machineById = new Map(machine.sessions.map((m) => [m.sessionId, m]));
  const cellsBySession = groupByKey(windowedCells, (c) => c.sessionId);

  const byJob = new Map<string, AutomationJobBucket>();
  const bump = (job: string, cost: number) => {
    const b = byJob.get(job) ?? { job, sessions: 0, cost: 0 };
    b.sessions += 1;
    b.cost += cost;
    byJob.set(job, b);
  };

  let interactiveSessionCount = 0;
  let automationSessionCount = 0;
  let automationCost = 0;

  // Scanned sessions: automation (manifest id, priced from transcript) vs
  // interactive (everything else, the headline count).
  for (const s of sessions) {
    if (!manifestIds.has(s.id)) { interactiveSessionCount += 1; continue; }
    const job = machineById.get(s.id)?.job ?? 'unknown';
    const cost = costOfBucketedCells(cellsBySession.get(s.id) ?? [], mode);
    bump(job, cost);
    automationSessionCount += 1;
    automationCost += cost;
  }

  // Absent-transcript manifest sessions (reaped session-close): priced from the
  // manifest usage cells via costOf, falling back to cost_usd only when the
  // model is unpriced (costOf null). Skip any whose transcript is present
  // (handled above) — dedup.
  for (const m of machine.sessions) {
    if (dbIds.has(m.sessionId)) continue;
    const day = m.ts ? m.ts.slice(0, 10) : undefined;
    const cost = costOf(m.model, m.usage as ModelUsageInput, day, mode) ?? (m.cost_usd ?? 0);
    bump(m.job, cost);
    automationSessionCount += 1;
    automationCost += cost;
  }

  return {
    interactiveSessionCount,
    automationSessionCount,
    automationCost,
    byJob: [...byJob.values()].sort((a, b) => b.cost - a.cost),
  };
}
