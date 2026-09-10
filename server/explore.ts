// server/explore.ts
// The pivot engine. Returns metric-AGNOSTIC per-cell aggregates keyed by
// model; the CLIENT projects to the chosen metric and prices Spend via
// src/models.ts costOf (the price table lives only there — never server-side).
// Exact for model/project/source/hour/subagent groups (per-message token
// columns + tags); tool/skill × tokens are CALIBRATED via calibrate.ts and the
// result carries calibrated:true. rollup='total' only in 5e (ranked bars).
import { db } from './db.ts';
import { queryContext, whereOf, type QueryContext, type Range, type Scope, type SqlFragment } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';
import { rangedUsage, bucketedUsage, bucketKeyExpr, type BucketedUsageCell, type UsageBucket } from './rangeUsage.ts';
import { addCellInto, emptyCell, parseUsage, type UsageCell } from '../shared/usage.ts';
// Per-tool/-group error attribution needs per-MESSAGE heads (a session-level
// count can't say WHICH tool errored), so this engine keeps its head query for
// those groups, but the heuristic itself is the shared server-side copy, and the
// session-level groups read the precomputed column instead (SESSION_ERROR_GROUPS).
import { ERROR_RE } from '../shared/errors.ts';
// group=session's label uses the SAME name → summary → first_prompt → id
// precedence as the Task 13 Activity route, instead of re-deriving it here.
import { sessionDisplayName } from '../shared/sessionName.ts';
// Bucket-key → axis-label formatting is shared with the client (feedback-round
// Task 18/D12: the client needs the identical format for zero-filled dense
// buckets) — see shared/bucketLabel.ts. Re-exported below so existing callers/
// tests (`explore.bucketLabel`) keep working unchanged.
import { bucketLabel } from '../shared/bucketLabel.ts';
export { bucketLabel };

export type ExploreMetric = 'spend' | 'tokens' | 'requests' | 'active' | 'sessions' | 'errors';
export type ExploreGroup = 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session' | 'mcp' | 'provider';
// 'total' collapses time (ranked bars). The four time rollups bucket the range
// into a stacked time-series; 'total' output is byte-identical to before this
// feature (plus the two scalar rollup fields on the result). See
// records/design/2026-08-11-chronicle-explore-rollups/spec.md.
export type ExploreRollup = 'total' | 'hourly' | 'daily' | 'weekly' | 'monthly';
export interface ExploreQuery {
  scope: Scope; range: Range;
  metric: ExploreMetric; group: ExploreGroup; subgroup?: ExploreGroup;
  rollup: ExploreRollup; topN: number;
}
export interface ExploreRow {
  key: string; label: string;
  tokensByModel: Record<string, UsageCell>;
  // Day-bucketed (LOCAL calendar day, YYYY-MM-DD) breakdown of tokensByModel —
  // Day bucket: lets the client price Spend per day-bucket at that day's rate
  // (e.g. Sonnet 5's intro window) instead of one flat rate for the whole
  // range. Only set for EXACT_USAGE_GROUPS (model/project/source/session),
  // where token magnitude is sourced from sessions.usage; sums across every
  // day reproduce tokensByModel's flat total exactly. Calibrated groups
  // (tool/skill) and per-message groups (hour/subagent) omit it — their
  // magnitude is already an approximation, priced at the latest/current rate.
  tokensByModelByDay?: Record<string, Record<string, UsageCell>>;
  requests: number; sessions: number; errors: number; activeMs: number;
  segments: { key: string; label: string; tokens: number }[];
  // Only set on the synthetic key==='Other' row: how many non-topN group
  // values were folded into it (the client's "+N in Other" legend reads this
  // — it has no way to derive N itself, since it only ever receives the
  // already-folded topN+Other row set, never the raw pre-fold list).
  otherCount?: number;
}
// One (bucket × series) cell in a time-rollup. Metric-SPECIALIZED: only the
// dimension the chosen metric reads is populated (tokensByModel for
// tokens/spend; the matching scalar for requests/sessions/errors/active), the
// rest stay zero. The client reuses its per-row metricValue/rowSpend/rowTokens
// on this same shape, so a cell projects to exactly one meaningful number.
export interface ExploreCell {
  tokensByModel: Record<string, UsageCell>;
  requests: number; sessions: number; errors: number; activeMs: number;
}
// One time bucket. `bucket` is the raw sortable key (ISO-ish); `label` is the
// short human string for the axis. `series` is keyed by the SAME group values
// chosen for the ranked rows (topN group values + 'Other'); a series absent
// from a bucket is simply omitted (the client fills 0 for continuous stacking).
export interface ExploreBucket { bucket: string; label: string; series: Record<string, ExploreCell>; }
export interface ExploreResult {
  metric: ExploreMetric; group: ExploreGroup; subgroup: ExploreGroup | null;
  calibrated: boolean; rows: ExploreRow[];
  // effective rollup actually rendered (post cap-coarsening); requestedRollup =
  // what the caller asked for. rollup !== requestedRollup ⇒ the client shows a
  // "too dense, showing <coarser>" note. buckets present iff rollup !== 'total'.
  rollup: ExploreRollup; requestedRollup: ExploreRollup; buckets?: ExploreBucket[];
}

// Chart legibility cap: at ~90 bars in a ~1000px plot each bar is ≈11px, still
// hoverable; beyond that bars become unreadable hairlines. When a range+bucket
// would exceed this, the effective rollup steps coarser until it fits.
export const ROLLUP_BUCKET_CAP = 90;
const ROLLUP_ORDER: Exclude<ExploreRollup, 'total'>[] = ['hourly', 'daily', 'weekly', 'monthly'];

// Each time rollup's granularity in server/rangeUsage.ts's vocabulary. Explore's wire
// names the four rollups hourly/daily/weekly/monthly and the bucketing primitive names
// the same four granularities hour/day/week/month, so this is the one place the two
// vocabularies meet. The rollup's token magnitude goes through that primitive (#306),
// which is what puts a session sitting on the range edge into each bucket at its
// in-range share instead of dropping its whole billed cell on its started_at bucket.
const USAGE_BUCKET_FOR: Record<Exclude<ExploreRollup, 'total'>, UsageBucket> = {
  hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month',
};

// SQL expression yielding a bucket key for a timestamp column: hourly
// "2026-08-09T14", daily "2026-08-09", weekly = that week's MONDAY date "2026-08-03",
// monthly "2026-08". LOCAL time, and the exact expression server/rangeUsage.ts's
// bucketKeyExpr owns, so this file's message-level queries and the bucketed-usage
// primitive can never key the same instant differently. It stays exported under the
// rollup names because that is the vocabulary every caller here, and its tests, speaks.
export function bucketExpr(rollup: Exclude<ExploreRollup, 'total'>, ts: string): string {
  return bucketKeyExpr(USAGE_BUCKET_FOR[rollup], ts);
}

// The guard a query KEYED by a message timestamp needs on top of the message
// range. The range is `AND <alias>.ts >= ?` when bounded and NOTHING under All
// (server/scope.ts), so under All a message with no timestamp — allowed by
// `shared/types.ts` and written through by server/db.ts — survives to the GROUP
// BY and keys a bucket with SQL NULL, which reaches the client as the literal
// string `"null"`. Same guard, same reason, as server/routes/projects.ts's
// activity query.
const tsNotNull = (alias: string): string => `AND ${alias}.ts IS NOT NULL`;

// Pure cap-coarsening: from the requested rollup, return the finest rollup whose
// bucket count fits the cap. `countFor` is called at most 3 times (monthly is
// terminal — never coarsened further). Exported for unit testing without a DB.
export function pickRollup(
  requested: Exclude<ExploreRollup, 'total'>,
  countFor: (r: Exclude<ExploreRollup, 'total'>) => number,
  cap = ROLLUP_BUCKET_CAP,
): Exclude<ExploreRollup, 'total'> {
  for (let i = ROLLUP_ORDER.indexOf(requested); i < ROLLUP_ORDER.length; i++) {
    const r = ROLLUP_ORDER[i];
    if (r === 'monthly' || countFor(r) <= cap) return r;
  }
  return 'monthly';
}

// D6. `mcp` (per-MCP-server spend, derived from the `mcp__server__tool`
// tool_name shape) is calibrated exactly like
// tool/skill: an MCP call is a tool_use row, so its token magnitude is
// estimated from its text share of the bucket's billed total. A turn can hit
// several MCP servers, so per-server figures double-count (MCP_DOUBLE_COUNT
// caveat). `provider` (model VENDOR — anthropic/openai/google, NOT `source`'s
// tool vendor) rides assistant rows that carry real tokens, so it stays a plain
// per-message group (not calibrated, not exact-override).
const CALIBRATED_GROUPS: ExploreGroup[] = ['tool', 'skill', 'mcp'];
// Groups whose token MAGNITUDE is sourced from the authoritative
// `sessions.usage` per-model billed totals (= Overview / Insights / Claude
// /usage), NOT the per-message token columns. Per-message columns capture only
// ~0.73 of billed usage (≈27% is never stored per-row, and ~70% of what is
// stored sits on tool_use rows, not assistant rows), so they cannot reconcile.
// requests/sessions/errors/activeMs for these groups STAY per-message (their
// natural units); only tokensByModel is overridden. hour/subagent are NOT here
// — they are inherently message-level (usage has no hour/agent_type split) and
// stay per-message by design. session is EXACT trivially: a session's own
// sessions.usage IS its group value's usage, no aggregation needed.
const EXACT_USAGE_GROUPS: ExploreGroup[] = ['model', 'project', 'source', 'session'];

// Groups whose error count needs no attribution INSIDE the session: the group value
// is a property of the session itself, so `sessions.error_count` (precomputed at
// import with the one shared heuristic (server/db.ts replaceSession, shared/errors.ts)
// already answers it. Every other group (tool/skill/model/subagent/mcp/provider/
// hour) has to say WHICH tool, model or hour errored, which only the per-message head
// query can, so those keep it.
//
// KNOWN RANGE TRADEOFF, the same one server/insights.ts's errorsByProject documents
// at length: error_count is a WHOLE-SESSION total, so under a range a session that
// overlaps the edge contributes its full historical error count rather than only the
// errors inside the range. Re-slicing it per request would mean re-running exactly
// the tool_result/tool_use pairing query this path exists to avoid. The rollup below
// buckets the same column by session start, so the total bar and the stacked chart
// still agree.
const SESSION_ERROR_GROUPS: ExploreGroup[] = ['project', 'source', 'session'];

// Which row an in-range usage cell belongs to, for the four groups whose magnitude is
// sourced from sessions.usage. The ranked rows and the rollup buckets both key off
// this, so they cannot disagree about where a cell lands. group='project' is keyed by
// project NAME, the way groupExpr('project') keys the message-level rows, since a
// usage cell carries only the id.
function usageRowKey(group: ExploreGroup, c: BucketedUsageCell, projectNameById: Map<number, string>): string {
  switch (group) {
    case 'model': return c.model;
    case 'project': return projectNameById.get(c.projectId) ?? '';
    case 'session': return c.sessionId;
    default: return c.source;
  }
}

// Precomputed per-session error counts per group value, optionally split across time
// buckets. One query shape for the ranked rows and the rollup, and the session range,
// scope clause and minor gate come from the one query context (see
// SESSION_ERROR_GROUPS). `bucketExpr` is the caller's, so its binds (if any) come
// first, ahead of the context's own.
function sessionErrorRows(
  group: ExploreGroup, q: QueryContext,
  bucketExpr: string | null, bucketBinds: (string|number)[] = [],
): { gk: string|number|null; bkt: string; errors: number }[] {
  const bkt = bucketExpr ? `${bucketExpr} AS bkt` : `'' AS bkt`;
  const w = q.sessionRows;
  return db.prepare(`
    SELECT ${errorGroupCol(group)} AS gk, ${bkt}, SUM(COALESCE(s.error_count, 0)) AS errors
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${w.sql}
    GROUP BY gk, bkt
  `).all(...bucketBinds, ...w.params) as unknown as { gk: string|number|null; bkt: string; errors: number }[];
}

// One parsed `sessions.usage` row's per-model billed cells, plus the session's
// project name + source so a single scan feeds model/project/source grouping,
// and its name/summary/first_prompt so the same scan also resolves
// group=session's display label (see the session-label step below) without a
// second sessions×projects query.
interface SessionUsageParsed {
  id: string; project: string; source: string; models: Record<string, UsageCell>;
  name: string | null; summary: string | null; first_prompt: string | null;
}
// Loads in-scope sessions' metadata (name/summary/first_prompt for label resolution) +
// raw usage, honoring the SAME scope, minor gate and session range the message
// queries use (so its session set matches rangedUsage's — a session
// spanning the cutoff isn't dropped here while being included there). Token MAGNITUDE
// no longer comes from this raw parse (see rangedUsage call sites below); this is now
// a metadata/label-only loader.
function loadSessionUsage(q: QueryContext): SessionUsageParsed[] {
  const w = q.sessionRows;
  const rows = db.prepare(`
    SELECT s.id AS id, p.name AS project, s.source AS source, s.usage AS usage,
           s.name AS name, s.summary AS summary, s.first_prompt AS first_prompt
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${w.sql}
  `).all(...w.params) as unknown as { id: string; project: string; source: string; usage: string|null; name: string|null; summary: string|null; first_prompt: string|null }[];
  return rows.map((r) => ({
    id: r.id, project: r.project, source: r.source, models: parseUsage(r.usage),
    name: r.name, summary: r.summary, first_prompt: r.first_prompt,
  }));
}

// MCP server name derived from an `mcp__server__tool` tool_name, keeping the
// `.` alias so it works against the joined query.
const mcpServerExpr = (alias: string): string =>
  `substr(${alias}.tool_name, 6, instr(substr(${alias}.tool_name, 6), '__') - 1)`;
// Model VENDOR — NOT `source` (that is the TOOL vendor
// claude-code/codex/…). Prefix-mapped from the model id; the new stack/pivot
// axis for spend.
const providerExpr = (alias: string): string =>
  `CASE
     WHEN ${alias}.model LIKE 'claude%' THEN 'anthropic'
     WHEN ${alias}.model LIKE 'gpt%' OR ${alias}.model LIKE 'codex%' OR ${alias}.model LIKE 'o1%' OR ${alias}.model LIKE 'o3%' OR ${alias}.model LIKE 'o4%' THEN 'openai'
     WHEN ${alias}.model LIKE 'gemini%' THEN 'google'
     ELSE 'other'
   END`;

// SQL column/join to realize a group. Session-level groups (project/source)
// join nothing extra; message-level (model/tool/skill/subagent/hour/mcp/
// provider) read from messages m. subagent = agent_type WHERE is_sidechain=1.
function groupExpr(g: ExploreGroup): { col: string; where: string } {
  switch (g) {
    case 'project': return { col: 'p.name', where: '' };
    case 'source': return { col: 's.source', where: '' };
    // gk = session id (drives row-click navigation to /session/:id); the
    // human-readable label is resolved separately below (name → summary →
    // first_prompt → id), since a raw id is never what should be displayed.
    case 'session': return { col: 's.id', where: '' };
    case 'model': return { col: 'm.model', where: "AND m.kind='assistant' AND m.model IS NOT NULL" };
    case 'tool': return { col: 'm.tool_name', where: "AND m.kind='tool_use' AND m.tool_name IS NOT NULL" };
    case 'skill': return { col: 'm.skill', where: 'AND m.skill IS NOT NULL' };
    case 'subagent': return { col: 'm.agent_type', where: 'AND m.is_sidechain=1 AND m.agent_type IS NOT NULL' };
    // LOCAL hour-of-day (Task 18 sweep, round 2) — the client renders this via
    // fmtHourOfDay ("9 AM"/"10 PM"), which is meaningless unless the hour is
    // the user's own clock hour, not UTC. Same 'localtime' convention as
    // bucketExpr above.
    case 'hour': return { col: "CAST(strftime('%H', m.ts, 'localtime') AS INTEGER)", where: 'AND m.ts IS NOT NULL' };
    case 'mcp': return { col: mcpServerExpr('m'), where: "AND m.tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\'" };
    case 'provider': return { col: providerExpr('m'), where: "AND m.kind='assistant' AND m.model IS NOT NULL" };
    default: throw new Error(`explore.ts groupExpr: unknown group "${g as string}"`);
  }
}

// The same group value groupExpr resolves, but sourced from the erroring
// tool_result's PAIRED tool_use row (u) instead of `m` — used only by the
// errors query below. tool_use rows carry tool_name/skill/agent_type; model
// is usually null on a tool_use (it's not an assistant turn), so error rows
// simply don't attribute to any model-group row, which is correct.
function errorGroupCol(g: ExploreGroup): string {
  switch (g) {
    case 'project': return 'p.name';
    case 'source': return 's.source';
    case 'session': return 's.id';
    case 'model': return 'u.model';
    case 'tool': return 'u.tool_name';
    case 'skill': return 'u.skill';
    case 'subagent': return 'u.agent_type';
    case 'hour': return "CAST(strftime('%H', r.ts, 'localtime') AS INTEGER)";
    // errors attribute from the erroring tool_result's PAIRED tool_use row (u):
    // mcp reads its server off u.tool_name; provider off u.model (usually null on
    // a tool_use, so error rows simply don't attribute to a provider — correct).
    case 'mcp': return mcpServerExpr('u');
    case 'provider': return providerExpr('u');
    default: throw new Error(`explore.ts errorGroupCol: unknown group "${g as string}"`);
  }
}

export function computeExplore(query: ExploreQuery): ExploreResult {
  const q = queryContext(query.scope, query.range);
  // Session range = OVERLAP (a session whose activity ran INTO the range counts,
  // not just one that STARTED in it); message range = TIMESTAMP, so message-level
  // aggregates below only count messages that actually fall in-range (not every
  // message of a session that merely overlaps it) — see server/scope.ts.
  const messageWhere = q.messageRows;
  const base = `JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
    WHERE ${messageWhere.sql}`;
  const bind = (extra: (string|number)[] = []) => [...messageWhere.params, ...extra];
  // Token MAGNITUDE for tool/skill is always calibrated (deterministic, metric-
  // independent) so the Detail table's Tokens/$ columns are correct under every
  // metric. The `calibrated` flag below only drives the ≈ badge, so it stays
  // tied to the displayed metric — no ≈ noise when viewing errors/requests.
  const tokensAreCalibrated = CALIBRATED_GROUPS.includes(query.group);
  const calibrated = tokensAreCalibrated && (query.metric === 'tokens' || query.metric === 'spend');

  // Per (groupValue, model) exact token + request aggregates. For calibrated
  // groups the token columns are meaningless on those message kinds, so tokens
  // are overwritten below via calibrateByBucket; requests/errors stay exact.
  // NOTE on `requests`: COUNT(*) counts whichever message kind each group's
  // g.where filters `m` down to — assistant turns for model, tool_use rows
  // for tool, sidechain assistant turns for subagent, but ALL message kinds
  // for project/source/hour (g.where is '' there). That's intentional: each
  // group's natural request unit differs (a "request" under model/subagent
  // is an LLM turn, under tool is a tool call, under project/source/hour it's
  // any logged event) — not a bug to unify.
  const g = groupExpr(query.group);
  const cellRows = db.prepare(`
    SELECT ${g.col} AS gk, COALESCE(m.model,'') AS model,
           COALESCE(SUM(m.input_tokens),0) AS input, COALESCE(SUM(m.output_tokens),0) AS output,
           COALESCE(SUM(m.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(m.cache_w5m_tokens),0) AS cacheWrite5m,
           COALESCE(SUM(m.cache_w1h_tokens),0) AS cacheWrite1h,
           COUNT(*) AS requests, COUNT(DISTINCT s.id) AS sessions
    FROM messages m ${base} ${g.where}
    GROUP BY gk, model
  `).all(...bind()) as unknown as (UsageCell & { gk: string|number; model: string; requests: number; sessions: number })[];

  // Assemble rows keyed by group value.
  const rowMap = new Map<string, ExploreRow>();
  for (const c of cellRows) {
    const key = String(c.gk);
    let row = rowMap.get(key);
    if (!row) { row = { key, label: key, tokensByModel: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [] }; rowMap.set(key, row); }
    if (c.model) row.tokensByModel[c.model] = { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite5m: c.cacheWrite5m, cacheWrite1h: c.cacheWrite1h };
    row.requests += c.requests;
    row.sessions = Math.max(row.sessions, c.sessions); // distinct-per-model max is an approximation; exact distinct-per-group below for accuracy
  }

  // Exact distinct sessions per group value (the per-model max above is only a floor).
  const sessRows = db.prepare(`
    SELECT ${g.col} AS gk, COUNT(DISTINCT s.id) AS sessions
    FROM messages m ${base} ${g.where} GROUP BY gk
  `).all(...bind()) as unknown as { gk: string|number; sessions: number }[];
  for (const s of sessRows) { const r = rowMap.get(String(s.gk)); if (r) r.sessions = s.sessions; }

  // Errors: each erroring tool_result is counted EXACTLY ONCE, attributed via
  // its PAIRED tool_use (tool_use_id join) — not a cross-join against every
  // tool_result co-resident in the session (that over-counted multiplicatively
  // for project/source/hour, where g.where is '' and `m` ranges over every
  // message in the session, and misattributed for tool/skill/subagent since
  // an arbitrary same-session tool_result isn't the one that actually errored
  // for that group value).
  if (SESSION_ERROR_GROUPS.includes(query.group)) {
    for (const e of sessionErrorRows(query.group, q, null)) {
      if (e.gk == null) continue;
      const r = rowMap.get(String(e.gk));
      if (r) r.errors = e.errors;
    }
  } else {
    const errWhere = whereOf(q.sessions(), q.where, q.messages('r'));  // alias r, not m
    const errRows = db.prepare(`
      SELECT ${errorGroupCol(query.group)} AS gk, substr(r.text,1,200) AS head
      FROM messages r
      JOIN messages u ON u.id = (
        SELECT MIN(u2.id) FROM messages u2
        WHERE u2.session_id = r.session_id AND u2.tool_use_id = r.tool_use_id AND u2.kind = 'tool_use'
      )
      JOIN sessions s ON s.id = r.session_id
      JOIN projects p ON p.id = s.project_id
      WHERE r.kind = 'tool_result' AND r.text IS NOT NULL
        AND ${errWhere.sql}
    `).all(...errWhere.params) as unknown as { gk: string|number|null; head: string }[];
    for (const e of errRows) {
      if (e.gk == null || !ERROR_RE.test(e.head)) continue;
      const r = rowMap.get(String(e.gk));
      if (r) r.errors++;
    }
  }

  // Active ms per group value (session agent_active_ms attributed to each group
  // value present in the session — an approximation for message-level groups;
  // exact for project/source which are 1:1 with the session).
  if (query.metric === 'active') {
    const actRows = db.prepare(`
      SELECT ${g.col} AS gk, s.id AS sid, COALESCE(s.agent_active_ms,0) AS ms
      FROM messages m ${base} ${g.where} GROUP BY gk, sid
    `).all(...bind()) as unknown as { gk: string|number; sid: string; ms: number }[];
    for (const a of actRows) { const r = rowMap.get(String(a.gk)); if (r) r.activeMs += a.ms; }
  }

  // Token-magnitude override for EXACT groups (model/project/source): replace
  // the per-message tokensByModel (which undercounts vs Overview) with the
  // authoritative sessions.usage per-model billed cells. requests/sessions/
  // errors/activeMs (built above) stay per-message. Rows present per-message
  // but absent from usage get an empty tokensByModel; rows present in usage but
  // not per-message (a model that only appears in usage) are created so token/
  // spend metrics are complete. topN/Other folding below is unaffected (it sums
  // tokensByModel generically). GATED to token/spend metrics only: those are
  // the only metrics that read tokensByModel, and running the override for
  // requests/sessions/errors/active would materialize spurious zero-count rows
  // for usage-only models (no per-message rows), skewing those metrics.
  // Hoisted so the group=session label step below can reuse this same scan
  // (name/summary/first_prompt are already selected alongside usage) instead
  // of re-querying sessions×projects with the identical scope/cutoff/minorGate
  // filters a second time.
  // Project id → name, needed to key EXACT_USAGE_GROUPS' group='project' rows the same way
  // groupExpr('project') keys cellRows (p.name) — rangedUsage's cells carry projectId,
  // not the name. Only queried when actually needed (group='project').
  const projectNameById = query.group === 'project'
    ? new Map((db.prepare('SELECT id, name FROM projects').all() as unknown as { id: number; name: string }[]).map((p) => [p.id, p.name]))
    : new Map<number, string>();

  let usageRows: SessionUsageParsed[] = [];
  // Hoisted so the rollup below can reuse this exact scan when its granularity is also
  // 'day' (the two calls take identical arguments) instead of paying for a second
  // sessions×messages pass over the same rows.
  let dayBucketedCells: BucketedUsageCell[] | null = null;
  if (EXACT_USAGE_GROUPS.includes(query.group)) {
    // Token MAGNITUDE for these groups comes from bucketedUsage (Task 2; day-
    // bucketed) — per-session, per-model, per-LOCAL-day billed cells scaled to their
    // in-range share of per-message tokens — not loadSessionUsage's raw `sessions.usage`
    // parse, which (even after its own overlapGate fix above) would over-count a spanning
    // session's FULL billed usage instead of its in-range share. Day-bucketed (rather than
    // the plain rangedUsage) so tokensByModelByDay can be populated alongside the
    // day-collapsed tokensByModel total, letting the client price a range straddling a rate
    // change (e.g. Sonnet 5's intro window) correctly.
    const bucketedCells = bucketedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso, 'day');
    dayBucketedCells = bucketedCells;
    const acc = new Map<string, Record<string, UsageCell>>();
    const accByDay = new Map<string, Map<string, Record<string, UsageCell>>>();
    for (const c of bucketedCells) {
      const rowKey = usageRowKey(query.group, c, projectNameById);
      let byModel = acc.get(rowKey);
      if (!byModel) { byModel = {}; acc.set(rowKey, byModel); }
      addCellInto(byModel, c.model, c.cells);
      let byDay = accByDay.get(rowKey);
      if (!byDay) { byDay = new Map(); accByDay.set(rowKey, byDay); }
      let dayModel = byDay.get(c.bucket);
      if (!dayModel) { dayModel = {}; byDay.set(c.bucket, dayModel); }
      addCellInto(dayModel, c.model, c.cells);
    }
    // group='session' still needs display labels (name → summary → first_prompt → id) —
    // bucketedUsage doesn't carry those fields (framework-free by design, see its header),
    // so a separate lightweight metadata load resolves them below; magnitude above already
    // came from bucketedCells, this is label-only.
    if (query.group === 'session') usageRows = loadSessionUsage(q);
    for (const row of rowMap.values()) {
      const usageCells = acc.get(row.key);
      const dayCells = accByDay.get(row.key);
      if (dayCells) row.tokensByModelByDay = Object.fromEntries(dayCells);
      if (usageCells) { row.tokensByModel = usageCells; continue; }
      // No sessions.usage for this group value. For model/project/source this
      // means genuinely zero billed usage in scope — blank to {} as before.
      // For session it more often means the session's SOURCE never populates
      // sessions.usage at all (codex/cursor/opencode — only claudeCode writes
      // it at import): blanking to {} would show Tokens=0/$0.00 next to a
      // real nonzero Requests count on the SAME row, reading as a bug. Keep
      // the per-message tokensByModel cellRows already built above instead —
      // the same non-exact-but-unmarked path hour/subagent already use (see
      // groupShowsTokenColumn / EXP-02): real numbers for codex (which does
      // carry per-message input_tokens/output_tokens), and an honest 0 for
      // cursor/opencode (which carry no token telemetry at all, per-message
      // or per-session — nothing to fall back to).
      if (query.group !== 'session') row.tokensByModel = {};
    }
    // Only materialize usage-only rows (a model billed but with no per-message
    // rows) when the displayed metric actually reads token magnitude — else
    // they'd show as spurious zero-request/zero-session rows under other metrics.
    if (query.metric === 'tokens' || query.metric === 'spend') {
      for (const [k, byModel] of acc) {
        if (!rowMap.has(k)) {
          const dayCells = accByDay.get(k);
          rowMap.set(k, {
            key: k, label: k, tokensByModel: byModel,
            tokensByModelByDay: dayCells ? Object.fromEntries(dayCells) : undefined,
            requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [],
          });
        }
      }
    }
  }

  // group=session: key IS the session id (so the client can navigate to
  // /session/:id on row click), but the raw id is a bad label — resolve the
  // display label with the same name → summary → first_prompt → id
  // precedence as the Task 13 Activity route (server/activity.ts
  // sessionDisplayName), reusing the `usageRows` scan above (session ∈
  // EXACT_USAGE_GROUPS, so it's already populated whenever this runs) rather
  // than a second sessions×projects query with the same filters. Covers
  // usage-only rows materialized above too, since usageRows enumerates every
  // in-scope session regardless of whether it has usage.
  if (query.group === 'session') {
    for (const u of usageRows) {
      const r = rowMap.get(u.id);
      if (r) r.label = sessionDisplayName({ id: u.id, name: u.name, summary: u.summary, first_prompt: u.first_prompt }, 'id');
    }
  }

  let rows = [...rowMap.values()];

  // Calibrated token override for tool/skill groups. A single ''-keyed cell
  // (the original shape) makes client Spend pricing (costOf) return null —
  // pricingFor('') is falsy so `if (!model) return null` short-circuits in
  // src/models.ts — so instead distribute each row's calibrated token total
  // across the scope's REAL assistant-turn models by their billed token
  // share (modelSplitRows), preserving each model's own input:output ratio.
  // This gives a real blended $ via costOf while staying keyed by model.
  if (tokensAreCalibrated) {
    // Char measure includes tool_input, not just text: tool_use rows (the
    // 'tool' group, and skill-tagged tool_use rows for 'skill') store their
    // content in tool_input — text is NULL for kind='tool_use' — so summing
    // text alone always yielded 0 chars for those groups, and every
    // calibrated tool/skill row came out $0/0 tokens regardless of scope or
    // date range (5e-1 code review caught this against real data). Skill
    // rows are also tool_use rows, so this fix covers both CALIBRATED_GROUPS.
    const charRows = db.prepare(`
      SELECT ${g.col} AS gk, COALESCE(SUM(LENGTH(COALESCE(m.text,'')) + LENGTH(COALESCE(m.tool_input,''))),0) AS chars
      FROM messages m ${base} ${g.where} GROUP BY gk
    `).all(...bind()) as unknown as { gk: string|number; chars: number }[];
    // Calibration base + per-model split come from rangedUsage — the
    // authoritative sessions.usage (input+output = the Insights Tokens KPI, per the 5d
    // "narrow Insights Tokens to input+output" decision) SCALED to the in-range share,
    // NOT per-message assistant sums and not the raw unscaled billed cell — so calibrated
    // tool/skill Spend prices off the real in-range billed total at a real blended rate.
    const rangedCells = rangedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso);
    const modelSplit = new Map<string, { input: number; output: number }>();
    let billedAll = 0;
    for (const c of rangedCells) {
      const cur = modelSplit.get(c.model) ?? { input: 0, output: 0 };
      cur.input += c.cells.input; cur.output += c.cells.output;
      modelSplit.set(c.model, cur);
      billedAll += c.cells.input + c.cells.output;
    }
    const cal = calibrateByBucket(charRows.map((c) => ({ key: String(c.gk), chars: c.chars })), billedAll);
    const byKey = new Map(cal.map((c) => [c.key, c.tokens]));

    const modelSplitRows = [...modelSplit.entries()].map(([model, v]) => ({ model, input: v.input, output: v.output }));

    for (const r of rows) {
      const T = byKey.get(r.key) ?? 0;
      if (billedAll <= 0) {
        // Nothing billed in scope at all — spend 0 is acceptable; fall back
        // to the single empty-model cell rather than dividing by zero.
        r.tokensByModel = { '': { ...emptyCell(), input: T } };
        continue;
      }
      const tokensByModel: Record<string, UsageCell> = {};
      for (const ms of modelSplitRows) {
        const msTotal = ms.input + ms.output;
        if (msTotal <= 0) continue;
        const modelTokens = Math.round(T * (msTotal / billedAll));
        const input = Math.round(modelTokens * (ms.input / msTotal));
        const output = modelTokens - input;
        tokensByModel[ms.model] = { ...emptyCell(), input, output };
      }
      r.tokensByModel = tokensByModel;
    }
  }

  // Rank by a rough magnitude (tokens for token/spend metrics, else requests)
  // so topN + Other folding is stable regardless of the client's final metric.
  const mag = (r: ExploreRow) => {
    if (query.metric === 'requests') return r.requests;
    if (query.metric === 'sessions') return r.sessions;
    if (query.metric === 'errors') return r.errors;
    if (query.metric === 'active') return r.activeMs;
    return Object.values(r.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  };
  rows.sort((a, b) => mag(b) - mag(a));
  if (rows.length > query.topN) {
    const keep = rows.slice(0, query.topN);
    const rest = rows.slice(query.topN);
    const other: ExploreRow = { key: 'Other', label: 'Other', tokensByModel: {}, tokensByModelByDay: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [], otherCount: rest.length };
    for (const r of rest) {
      other.requests += r.requests; other.errors += r.errors; other.activeMs += r.activeMs;
      other.sessions += r.sessions;
      for (const [model, u] of Object.entries(r.tokensByModel)) addCellInto(other.tokensByModel, model, u);
      for (const [day, byModel] of Object.entries(r.tokensByModelByDay ?? {})) {
        const dayAcc = other.tokensByModelByDay![day] ?? {};
        for (const [model, u] of Object.entries(byModel)) addCellInto(dayAcc, model, u);
        other.tokensByModelByDay![day] = dayAcc;
      }
    }
    if (Object.keys(other.tokensByModelByDay!).length === 0) other.tokensByModelByDay = undefined;
    rows = [...keep, other];
  }

  // Subgroup segments (stacked bars) — tokens per (group, subgroup) cell.
  // Skipped for calibrated (tool/skill) groups: subgroup values live on the
  // same tool_use/skill rows whose raw m.input_tokens/output_tokens are ~0
  // (the real tokens are calibrated post-hoc above, not summed per-row), so a
  // raw SUM here would render a near-zero, misleading stack. Leave segments
  // [] — the UI renders a single full-width bar when segments is empty.
  if (query.subgroup && !tokensAreCalibrated) {
    const sg = groupExpr(query.subgroup);
    const segRows = db.prepare(`
      SELECT ${g.col} AS gk, ${sg.col} AS sk,
             COALESCE(SUM(m.input_tokens),0)+COALESCE(SUM(m.output_tokens),0) AS tokens
      FROM messages m ${base} ${g.where} ${sg.where} GROUP BY gk, sk
    `).all(...bind()) as unknown as { gk: string|number; sk: string|number; tokens: number }[];
    const byRow = new Map<string, { key: string; label: string; tokens: number }[]>();
    for (const s of segRows) {
      const arr = byRow.get(String(s.gk)) ?? [];
      arr.push({ key: String(s.sk), label: String(s.sk), tokens: s.tokens });
      byRow.set(String(s.gk), arr);
    }
    for (const r of rows) r.segments = (byRow.get(r.key) ?? []).sort((a, b) => b.tokens - a.tokens);
  }

  // Time rollups (rollup !== 'total'): keep `rows` as the range totals (Detail
  // table + Total-view bars) and additionally return per-bucket series for the
  // stacked time-series. `hourly` is requested EXPLICITLY by the client (the
  // Hourly pivot chip) and must always render at hourly granularity — density
  // is the client's problem, solved with a windowed Recharts <Brush> (default
  // window = last 72 buckets), not by silently coarsening to daily server-side
  // (a real request for "today, hourly" used to come back as "today, one bar").
  // daily/weekly/monthly still cap-coarsen forward (cheap COUNT(DISTINCT
  // bucket) over the in-scope timeline per step) since those requests have no
  // brush and a multi-year weekly/monthly range can still overflow the
  // legibility cap. `rows` already carries the topN+Other fold, so its keys
  // ARE the series set.
  let effectiveRollup: ExploreRollup = 'total';
  let buckets: ExploreBucket[] | undefined;
  if (query.rollup !== 'total') {
    effectiveRollup = query.rollup === 'hourly' ? 'hourly' : pickRollup(query.rollup, (r) =>
      (db.prepare(`SELECT COUNT(DISTINCT ${bucketExpr(r, 'm.ts')}) AS n FROM messages m ${base}`)
        .get(...bind()) as { n: number }).n);
    buckets = computeRollupBuckets(query, effectiveRollup, rows, { q, messageWhere, base, g, projectNameById, dayBucketedCells });
  }

  return {
    metric: query.metric, group: query.group, subgroup: query.subgroup ?? null, calibrated, rows,
    rollup: effectiveRollup, requestedRollup: query.rollup, buckets,
  };
}

// ---- the route's wire shape ----
// Explore's JSON has always named the two cache-write tiers `cw5m`/`cw1h`,
// while every other surface (and `sessions.usage` itself) names them
// `cacheWrite5m`/`cacheWrite1h`. #301 consolidates the dialects but requires
// every route's JSON to stay identical, so the older names survive on the wire
// and nowhere else: the engine above computes in the one shared dialect
// (shared/usage.ts) from parse to fold, and only the serialized answer is
// renamed, here, in one place. Renaming the wire itself means changing what
// /api/explore returns, which is a surface-contract question, not this
// consolidation's.
export interface ExploreWireCell { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }
export interface ExploreWireRow extends Omit<ExploreRow, 'tokensByModel' | 'tokensByModelByDay'> {
  tokensByModel: Record<string, ExploreWireCell>;
  tokensByModelByDay?: Record<string, Record<string, ExploreWireCell>>;
}
export interface ExploreWireCellSet extends Omit<ExploreCell, 'tokensByModel'> {
  tokensByModel: Record<string, ExploreWireCell>;
}
export interface ExploreWireBucket extends Omit<ExploreBucket, 'series'> {
  series: Record<string, ExploreWireCellSet>;
}
export interface ExploreWireResult extends Omit<ExploreResult, 'rows' | 'buckets'> {
  rows: ExploreWireRow[];
  buckets?: ExploreWireBucket[];
}

function wireCells(byModel: Record<string, UsageCell>): Record<string, ExploreWireCell> {
  const out: Record<string, ExploreWireCell> = {};
  for (const [model, c] of Object.entries(byModel)) {
    out[model] = { input: c.input, output: c.output, cacheRead: c.cacheRead, cw5m: c.cacheWrite5m, cw1h: c.cacheWrite1h };
  }
  return out;
}

// Serialize a computed result into Explore's frozen wire names. The route
// module is the only caller.
export function toWire(result: ExploreResult): ExploreWireResult {
  return {
    ...result,
    rows: result.rows.map((r) => ({
      ...r,
      tokensByModel: wireCells(r.tokensByModel),
      tokensByModelByDay: r.tokensByModelByDay
        ? Object.fromEntries(Object.entries(r.tokensByModelByDay).map(([day, byModel]) => [day, wireCells(byModel)]))
        : undefined,
    })),
    buckets: result.buckets?.map((b) => ({
      ...b,
      series: Object.fromEntries(Object.entries(b.series).map(([k, c]) => [k, { ...c, tokensByModel: wireCells(c.tokensByModel) }])),
    })),
  };
}

// Per-(bucket × series) aggregation for a time rollup. Metric-SPECIALIZED: only
// the dimension the chosen metric reads is populated per cell (see ExploreCell).
// `rows` supplies the series identity (its keys = topN group values + 'Other'),
// so the time-series stacks the SAME series the ranked/Detail views show, in the
// same colors. Non-topN group values fold into 'Other' per bucket.
interface RollupCtx {
  q: QueryContext; messageWhere: SqlFragment; base: string; g: { col: string; where: string };
  // Project id → name, so a usage cell (which carries projectId) can be keyed the way
  // groupExpr('project') keys the ranked rows. Populated only for group='project'.
  projectNameById: Map<number, string>;
  // The day-granularity bucketedUsage scan computeExplore already ran for the ranked
  // rows (EXACT_USAGE_GROUPS only, null otherwise), reused verbatim when this rollup's
  // granularity is 'day', since the call would take identical arguments.
  dayBucketedCells: BucketedUsageCell[] | null;
}
function computeRollupBuckets(query: ExploreQuery, effective: ExploreRollup, rows: ExploreRow[], ctx: RollupCtx): ExploreBucket[] {
  if (effective === 'total') return [];
  const { q, messageWhere, base, g, projectNameById, dayBucketedCells } = ctx;
  // `base` (from computeExplore) carries the session range, scope+minor gate and
  // the message range, in that order — its binds are messageWhere's, plus any
  // caller-supplied extras.
  const bind = (extra: (string|number)[] = []): (string|number)[] => [...messageWhere.params, ...extra];
  const bm = bucketExpr(effective, 'm.ts');
  const bs = bucketExpr(effective, 's.started_at');
  // A query KEYED by a message timestamp carries its own NULL guard on top of
  // the message range (#334): under All the range filters nothing, so an
  // untimestamped row reaches the GROUP BY and its NULL bucket key draws a
  // `"null"` bar. `mBase` is `base` plus that guard, for every scan below keyed
  // by `bm`; the `bs`-keyed scans (started_at) keep plain `base`, since dropping
  // a session's undated messages there would change WHICH SESSIONS the scan
  // sees, not just how they bucket.
  const mBase = `${base} ${tsNotNull('m')}`;
  // Billed `sessions.usage` cells for this rollup's granularity, scaled to each
  // bucket's share of the session's per-message tokens (#306). This replaces the old
  // started_at scan, which placed a session's WHOLE billed cell on the bucket it began
  // in: for a range whose edge splits a session that over-counted the rollup against
  // the ranked rows above (already rangedUsage/bucketedUsage-scaled), so the stacked
  // chart and the total bar disagreed. bucketedUsage's buckets sum to exactly the
  // ranged cell, so they now agree by construction. The scope clause, minor gate and
  // token range are the query context's, like every other scan in this file.
  const grain = USAGE_BUCKET_FOR[effective];
  const usageCells = (): BucketedUsageCell[] =>
    (grain === 'day' && dayBucketedCells)
      ? dayBucketedCells
      : bucketedUsage(db, q.where.sql, q.where.params, q.tokens.cutoffIso, grain);

  // series identity: topN group values are their own series; everything else
  // (present iff `rows` was folded) collapses to 'Other'.
  const topN = new Set(rows.filter((r) => r.key !== 'Other').map((r) => r.key));
  const hasOther = rows.some((r) => r.key === 'Other');
  const seriesKeyFor = (gv: string): string => (topN.has(gv) ? gv : (hasOther ? 'Other' : gv));

  const grid = new Map<string, Map<string, ExploreCell>>();
  const cell = (bkt: string, sk: string): ExploreCell => {
    let m = grid.get(bkt); if (!m) { m = new Map(); grid.set(bkt, m); }
    let c = m.get(sk); if (!c) { c = { tokensByModel: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0 }; m.set(sk, c); }
    return c;
  };

  if (query.metric === 'tokens' || query.metric === 'spend') {
    if (EXACT_USAGE_GROUPS.includes(query.group)) {
      // model/project/source/session magnitude from sessions.usage, bucketed and scaled
      // to in-range share by the same primitive the ranked rows read.
      for (const c of usageCells()) {
        addCellInto(cell(c.bucket, seriesKeyFor(usageRowKey(query.group, c, projectNameById))).tokensByModel, c.model, c.cells);
      }
    } else if (CALIBRATED_GROUPS.includes(query.group)) {
      // tool/skill: calibrate PER BUCKET (char share × that bucket's billed total),
      // then split across the bucket's real models — the range-total path, partitioned.
      const charRows = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk,
        COALESCE(SUM(LENGTH(COALESCE(m.text,'')) + LENGTH(COALESCE(m.tool_input,''))),0) AS chars
        FROM messages m ${mBase} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; chars: number }[];
      // The per-bucket billed base is the same in-range-scaled cell set the exact
      // branch reads, so a calibrated tool/skill bucket prices off the range's real
      // billed total rather than a spanning session's whole history.
      const billedByBucket = new Map<string, number>();
      const splitByBucket = new Map<string, Map<string, { input: number; output: number }>>();
      for (const c of usageCells()) {
        billedByBucket.set(c.bucket, (billedByBucket.get(c.bucket) ?? 0) + c.cells.input + c.cells.output);
        let sp = splitByBucket.get(c.bucket); if (!sp) { sp = new Map(); splitByBucket.set(c.bucket, sp); }
        const cur = sp.get(c.model) ?? { input: 0, output: 0 };
        cur.input += c.cells.input; cur.output += c.cells.output; sp.set(c.model, cur);
      }
      const charByBucket = new Map<string, { key: string; chars: number }[]>();
      for (const cr of charRows) { const a = charByBucket.get(cr.bkt) ?? []; a.push({ key: String(cr.gk), chars: cr.chars }); charByBucket.set(cr.bkt, a); }
      for (const [bkt, arr] of charByBucket) {
        const billed = billedByBucket.get(bkt) ?? 0;
        const split = splitByBucket.get(bkt);
        for (const { key: gk, tokens: T } of calibrateByBucket(arr, billed)) {
          const tbm = cell(bkt, seriesKeyFor(gk)).tokensByModel;
          if (!split || billed <= 0) { addCellInto(tbm, '', { ...emptyCell(), input: T }); continue; }
          for (const [model, v] of split) {
            const msTotal = v.input + v.output; if (msTotal <= 0) continue;
            const modelTokens = Math.round(T * (msTotal / billed));
            const input = Math.round(modelTokens * (v.input / msTotal));
            addCellInto(tbm, model, { ...emptyCell(), input, output: modelTokens - input });
          }
        }
      }
    } else {
      // hour/subagent: per-message token columns are exact, bucketed by m.ts.
      const mrows = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COALESCE(m.model,'') AS model,
        COALESCE(SUM(m.input_tokens),0) AS input, COALESCE(SUM(m.output_tokens),0) AS output,
        COALESCE(SUM(m.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(m.cache_w5m_tokens),0) AS cacheWrite5m, COALESCE(SUM(m.cache_w1h_tokens),0) AS cacheWrite1h
        FROM messages m ${mBase} ${g.where} GROUP BY bkt, gk, model`).all(...bind()) as unknown as (UsageCell & { bkt: string; gk: string|number; model: string })[];
      for (const r of mrows) {
        if (!r.model) continue;
        addCellInto(cell(r.bkt, seriesKeyFor(String(r.gk))).tokensByModel, r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h });
      }
    }
  } else if (query.metric === 'requests') {
    const rr = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COUNT(*) AS c FROM messages m ${mBase} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; c: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).requests += r.c;
  } else if (query.metric === 'sessions') {
    const rr = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COUNT(DISTINCT s.id) AS c FROM messages m ${mBase} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; c: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).sessions += r.c;
  } else if (query.metric === 'errors' && SESSION_ERROR_GROUPS.includes(query.group)) {
    // Precomputed per-session counts (see SESSION_ERROR_GROUPS), bucketed by session
    // start, the same placement `metric === 'active'` below uses for the other
    // whole-session precomputed column, agent_active_ms. Bucketing this column by the
    // erroring message's own ts is not available: the column is one number per
    // session, with no per-error timestamp to slice by.
    //
    // Clamped to the range with MAX(started_at, cutoff): a session that began months
    // before the range still overlaps it, and its unclamped start bucket would draw a
    // bar months outside the range the operator selected. The All range binds '',
    // where MAX is the start itself. (`metric === 'active'` below is unclamped and has
    // the same shape; changing what it draws is not this ticket's number change.)
    // bucketExpr repeats its timestamp argument (the weekly key reads it three times),
    // so the clamp's bind is repeated to match rather than assumed to appear once.
    const clamped = bucketExpr(effective, 'MAX(s.started_at, ?)');
    const clampBinds = Array((clamped.match(/\?/g) ?? []).length).fill(q.range.cutoffIso ?? '');
    // Only series the ranked rows actually carry: the rows drop a group value with no
    // in-range messages, so crediting it here would draw a bar the table has no line
    // for and break the reconciliation between them.
    const seriesInRows = new Set(rows.map((r) => r.key));
    for (const e of sessionErrorRows(query.group, q, clamped, clampBinds)) {
      if (e.gk == null) continue;
      const sk = seriesKeyFor(String(e.gk));
      if (!seriesInRows.has(sk)) continue;
      cell(String(e.bkt), sk).errors += e.errors;
    }
  } else if (query.metric === 'errors') {
    const errCol = errorGroupCol(query.group);
    // Keyed by the erroring tool_result's own timestamp, so it carries the same
    // NULL guard `mBase` carries above (#334) — an undated failing tool_result
    // would otherwise draw its errors on a `"null"` bar.
    const rollupErrWhere = whereOf(q.sessions(), q.where, q.messages('r'), tsNotNull('r'));
    const br = bucketExpr(effective, 'r.ts');
    const er = db.prepare(`SELECT ${br} AS bkt, ${errCol} AS gk, substr(r.text,1,200) AS head
      FROM messages r
      JOIN messages u ON u.id = (SELECT MIN(u2.id) FROM messages u2 WHERE u2.session_id = r.session_id AND u2.tool_use_id = r.tool_use_id AND u2.kind = 'tool_use')
      JOIN sessions s ON s.id = r.session_id JOIN projects p ON p.id = s.project_id
      WHERE r.kind = 'tool_result' AND r.text IS NOT NULL AND ${rollupErrWhere.sql}`).all(...rollupErrWhere.params) as unknown as { bkt: string; gk: string|number|null; head: string }[];
    for (const e of er) { if (e.gk == null || !ERROR_RE.test(e.head)) continue; cell(String(e.bkt), seriesKeyFor(String(e.gk))).errors++; }
  } else if (query.metric === 'active') {
    const rr = db.prepare(`SELECT ${bs} AS bkt, ${g.col} AS gk, s.id AS sid, COALESCE(s.agent_active_ms,0) AS ms
      FROM messages m ${base} ${g.where} GROUP BY bkt, gk, sid`).all(...bind()) as unknown as { bkt: string; gk: string|number; sid: string; ms: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).activeMs += r.ms;
  }

  return [...grid.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, series]) => ({ bucket, label: bucketLabel(bucket), series: Object.fromEntries(series) }));
}
