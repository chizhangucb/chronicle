// The token cell, and the one way to read one.
//
// A session's usage is five numbers per model: input, output, cache read, and
// cache writes at each of the two lifetimes (they are billed at different
// rates, so they stay split). That cell used to be declared five times under
// five names in two field-name dialects, with five copies of the parse of
// `sessions.usage` and an adapter between the dialects. It is declared here
// once, in the dialect the stored JSON and the price table already speak
// (`cacheWrite5m` / `cacheWrite1h`), and every surface — server engines and
// client aggregation alike — imports it (#301, audit F4).
//
// Framework-free, like the rest of `shared/`: no db handle, no express, no
// React. Relative imports only (`../shared/usage.ts`), never the `@shared`
// alias — value imports through the alias throw under plain `node --test`.

// One model's aggregated token usage. Every field is a plain count, never
// null: a cell that came out of `parseUsage` always has all five numbers.
export interface UsageCell {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// The `sessions.usage` map, keyed by model id, as stored (JSON.stringify of
// this object) and as every engine aggregates it.
export type UsageByModel = Record<string, UsageCell>;

// The five field names, in one place, so a fold over a cell cannot drift from
// the type.
export const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

// The raw JSON shape as it can appear on disk: every field optional (a source
// that records none of them writes none of them), and the legacy
// pre-TTL-split `cacheWrite` key, which was billed at the 5-minute rate.
export interface RawUsageCell {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  /** Legacy pre-TTL-split field; a 5-minute-tier write. */
  cacheWrite?: number | null;
}

export function emptyCell(): UsageCell {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

// Normalize one raw entry into a full cell: absent and null fields read zero,
// and a legacy `cacheWrite` folds onto the 5-minute tier.
function toCell(raw: RawUsageCell): UsageCell {
  return {
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    cacheRead: raw.cacheRead ?? 0,
    cacheWrite5m: raw.cacheWrite5m ?? raw.cacheWrite ?? 0,
    cacheWrite1h: raw.cacheWrite1h ?? 0,
  };
}

// Parse a `sessions.usage` blob. A missing, empty or unparseable blob is an
// empty map rather than a throw — a session may carry no usage at all, and a
// truncated write must not take a whole surface down. Entries that are not
// objects are skipped, so a malformed model key cannot become a NaN cell.
export function parseUsage(usage: string | null | undefined): UsageByModel {
  if (!usage) return {};
  let parsed: Record<string, RawUsageCell>;
  try {
    parsed = JSON.parse(usage) as Record<string, RawUsageCell>;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: UsageByModel = {};
  for (const [model, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== 'object') continue;
    out[model] = toCell(raw);
  }
  return out;
}

// Sum two cells, field by field. Pure: neither operand is touched, so it folds
// straight over an accumulator (`cells.reduce(addCell, emptyCell())`).
export function addCell(a: UsageCell, b: UsageCell): UsageCell {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

// Accumulate a cell onto a per-model map, the shape every engine builds while
// walking rows. Mutates `target` (it is the accumulator) and returns it.
export function addCellInto(target: UsageByModel, model: string, cell: UsageCell): UsageByModel {
  target[model] = addCell(target[model] ?? emptyCell(), cell);
  return target;
}

// Every token in one cell, across all five fields.
function cellTotal(cell: UsageCell): number {
  return cell.input + cell.output + cell.cacheRead + cell.cacheWrite5m + cell.cacheWrite1h;
}

// Every token in a per-model map.
export function totalTokens(cells: UsageByModel): number {
  let n = 0;
  for (const cell of Object.values(cells)) n += cellTotal(cell);
  return n;
}
