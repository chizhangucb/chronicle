// Explore's wire contract, declared once (#307, audit F10).
//
// Explore is the one surface whose JSON speaks its own token-cell dialect:
// `cw5m`/`cw1h` rather than the shared cell's `cacheWrite5m`/`cacheWrite1h`.
// The names are frozen (renaming them changes what /api/explore returns, which
// is a surface-contract question), so the engine computes in the one shared
// dialect from parse to fold and renames only the serialized answer, in
// server/explore.ts's `toWire`. What that produces — and what the client reads
// — is declared here, and the engine's in-memory shapes extend the same bases,
// so a field can only be added to both at once.
export type ExploreMetric = 'spend' | 'tokens' | 'requests' | 'active' | 'sessions' | 'errors';
export type ExploreGroup =
  | 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session' | 'mcp' | 'provider';
// 'total' collapses time (the ranked bars). The four time rollups bucket the
// range into a stacked time-series.
export type ExploreRollup = 'total' | 'hourly' | 'daily' | 'weekly' | 'monthly';

/** One model's token cell in Explore's frozen wire dialect. */
export interface ExploreWireCell { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }

/** Everything on a ranked row except its token cells, which differ between the
 * engine's dialect and the wire's. */
export interface ExploreRowBase {
  key: string;
  label: string;
  requests: number;
  sessions: number;
  errors: number;
  activeMs: number;
  segments: { key: string; label: string; tokens: number }[];
  /** Only set on the synthetic key==='Other' row: how many non-topN group
   * values were folded into it, for the "+N in Other" legend. */
  otherCount?: number;
}

export interface ExploreWireRow extends ExploreRowBase {
  tokensByModel: Record<string, ExploreWireCell>;
  /** Day-bucketed (LOCAL calendar day) breakdown of `tokensByModel`, so the
   * client can price a day at that day's rate. Only set for the exact-usage
   * groups (model/project/source/session). */
  tokensByModelByDay?: Record<string, Record<string, ExploreWireCell>>;
}

/** The scalar half of one (bucket × series) cell. */
export interface ExploreCellBase {
  requests: number;
  sessions: number;
  errors: number;
  activeMs: number;
}

/** One (bucket × series) cell on the wire. Metric-SPECIALIZED: only the
 * dimension the chosen metric reads is populated, the rest stay zero. */
export interface ExploreWireCellSet extends ExploreCellBase {
  tokensByModel: Record<string, ExploreWireCell>;
}

/** One time bucket. `bucket` is the raw sortable key; `label` is the short axis
 * string. A series absent from a bucket is omitted (the client fills 0). */
export interface ExploreWireBucket {
  bucket: string;
  label: string;
  series: Record<string, ExploreWireCellSet>;
}

export interface ExploreWireResult {
  metric: ExploreMetric;
  group: ExploreGroup;
  subgroup: ExploreGroup | null;
  calibrated: boolean;
  rows: ExploreWireRow[];
  /** The rollup actually rendered (post cap-coarsening); `requestedRollup` is
   * what the caller asked for. A difference means the client shows a "too
   * dense, showing <coarser>" note. `buckets` is present iff rollup !== 'total'. */
  rollup: ExploreRollup;
  requestedRollup: ExploreRollup;
  buckets?: ExploreWireBucket[];
}

/** The query string GET /api/explore takes. */
export interface ExploreQueryParams {
  scope: 'all' | 'project' | 'session';
  id?: string | number;
  days?: number | null;
  metric: ExploreMetric;
  group: ExploreGroup;
  subgroup?: ExploreGroup;
  topN?: number;
  rollup?: ExploreRollup;
}
