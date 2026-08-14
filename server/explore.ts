// server/explore.ts
// The pivot engine. Returns metric-AGNOSTIC per-cell aggregates keyed by
// model; the CLIENT projects to the chosen metric and prices Spend via
// src/models.ts costOf (the price table lives only there — never server-side).
// Exact for model/project/source/hour/subagent groups (per-message token
// columns + tags); tool/skill × tokens are CALIBRATED via calibrate.ts and the
// result carries calibrated:true. rollup='total' only in 5e (ranked bars).
import { db } from './db.ts';
import { scopeClause, minorGate, type Scope } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';
import { overlapGate, windowedUsage, type UsageCells } from './windowUsage.ts';
// Per-tool/-group error attribution needs per-MESSAGE heads (a session-level
// count can't say WHICH tool errored), so this engine keeps its head queries —
// but the heuristic itself is the shared server-side copy.
import { ERROR_RE } from './errors.ts';
// group=session's label uses the SAME name → summary → first_prompt → id
// precedence as the Task 13 Activity route, instead of re-deriving it here.
import { displayName } from './activity.ts';

export type ExploreMetric = 'spend' | 'tokens' | 'requests' | 'active' | 'sessions' | 'errors';
export type ExploreGroup = 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session';
// 'total' collapses time (ranked bars). The four time rollups bucket the range
// into a stacked time-series; 'total' output is byte-identical to before this
// feature (plus the two scalar rollup fields on the result). See
// records/design/2026-08-11-chronicle-explore-rollups/spec.md.
export type ExploreRollup = 'total' | 'hourly' | 'daily' | 'weekly' | 'monthly';
export interface ExploreQuery {
  scope: Scope; days: number | null;
  metric: ExploreMetric; group: ExploreGroup; subgroup?: ExploreGroup;
  rollup: ExploreRollup; topN: number;
}
export interface ModelUsageCell { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }
export interface ExploreRow {
  key: string; label: string;
  tokensByModel: Record<string, ModelUsageCell>;
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
  tokensByModel: Record<string, ModelUsageCell>;
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

// SQL expression yielding a bucket key for a timestamp column. Keys are chosen
// to sort chronologically as plain strings and to be directly labelable:
// hourly "2026-08-09T14", daily "2026-08-09", weekly = that week's MONDAY date
// "2026-08-03" (%w is 0=Sun..6=Sat; Monday offset = (%w+6)%7 days back),
// monthly "2026-08".
export function bucketExpr(rollup: Exclude<ExploreRollup, 'total'>, ts: string): string {
  switch (rollup) {
    case 'hourly': return `substr(${ts}, 1, 13)`;
    case 'daily': return `substr(${ts}, 1, 10)`;
    case 'weekly': return `date(${ts}, '-' || ((CAST(strftime('%w', ${ts}) AS INTEGER) + 6) % 7) || ' days')`;
    case 'monthly': return `substr(${ts}, 1, 7)`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Deterministic short axis label from a bucket key (branch on key length so one
// formatter serves all four rollups; no locale, matching the mono axis style).
export function bucketLabel(key: string): string {
  const mon = (m: string): string => MONTHS[Math.max(0, Math.min(11, Number(m) - 1))];
  if (key.length === 13) return `${mon(key.slice(5, 7))} ${Number(key.slice(8, 10))} ${key.slice(11, 13)}h`; // hourly
  if (key.length === 10) return `${mon(key.slice(5, 7))} ${Number(key.slice(8, 10))}`; // daily / weekly (Monday date)
  if (key.length === 7) return `${mon(key.slice(5, 7))} ${key.slice(0, 4)}`; // monthly
  return key;
}

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

const CALIBRATED_GROUPS: ExploreGroup[] = ['tool', 'skill'];
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

// One parsed `sessions.usage` row's per-model billed cells, plus the session's
// project name + source so a single scan feeds model/project/source grouping,
// and its name/summary/first_prompt so the same scan also resolves
// group=session's display label (see the session-label step below) without a
// second sessions×projects query.
interface SessionUsageParsed {
  id: string; project: string; source: string; models: Record<string, ModelUsageCell>;
  name: string | null; summary: string | null; first_prompt: string | null;
}
// The raw JSON shape stored in sessions.usage (field names are
// cacheWrite5m/cacheWrite1h/cacheRead; legacy `cacheWrite` = a 5m write).
interface RawUsageCell { input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number; cacheWrite?: number; }

function parseUsageCells(usage: string | null): Record<string, ModelUsageCell> {
  if (!usage) return {};
  let parsed: Record<string, RawUsageCell>;
  try { parsed = JSON.parse(usage) as Record<string, RawUsageCell>; } catch { return {}; }
  const out: Record<string, ModelUsageCell> = {};
  for (const [model, u] of Object.entries(parsed)) {
    if (!u || typeof u !== 'object') continue;
    out[model] = {
      input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0,
      cw5m: u.cacheWrite5m ?? u.cacheWrite ?? 0, cw1h: u.cacheWrite1h ?? 0,
    };
  }
  return out;
}

// Loads in-scope sessions' metadata (name/summary/first_prompt for label resolution) +
// raw usage, honoring the SAME scope + days + COALESCE(minor,0)=0 gate the message
// queries use, via overlapGate (so its session set matches windowedUsage's — a session
// spanning the cutoff isn't dropped here while being included there). Token MAGNITUDE
// no longer comes from this raw parse (see windowedUsage call sites below); this is now
// a metadata/label-only loader.
function loadSessionUsage(cutoff: string, sc: { sql: string; params: (string|number)[] }, scope: Scope): SessionUsageParsed[] {
  const rows = db.prepare(`
    SELECT s.id AS id, p.name AS project, s.source AS source, s.usage AS usage,
           s.name AS name, s.summary AS summary, s.first_prompt AS first_prompt
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${overlapGate('s')} ${minorGate(scope)} ${sc.sql}
  `).all(cutoff, ...sc.params) as unknown as { id: string; project: string; source: string; usage: string|null; name: string|null; summary: string|null; first_prompt: string|null }[];
  return rows.map((r) => ({
    id: r.id, project: r.project, source: r.source, models: parseUsageCells(r.usage),
    name: r.name, summary: r.summary, first_prompt: r.first_prompt,
  }));
}

// Maps windowUsage.ts's UsageCells (cacheWrite5m/cacheWrite1h field names) onto this
// file's own ModelUsageCell shape (cw5m/cw1h) — same values, different field names (the
// Task 1 review's carried "consolidate parseUsage" pointer stayed deferred rather than
// unifying the two shapes; this is the small adapter instead).
function toModelUsageCell(c: UsageCells): ModelUsageCell {
  return { input: c.input, output: c.output, cacheRead: c.cacheRead, cw5m: c.cacheWrite5m, cw1h: c.cacheWrite1h };
}

function addCell(target: Record<string, ModelUsageCell>, model: string, cell: ModelUsageCell): void {
  const cur = target[model] ?? { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
  cur.input += cell.input; cur.output += cell.output; cur.cacheRead += cell.cacheRead; cur.cw5m += cell.cw5m; cur.cw1h += cell.cw1h;
  target[model] = cur;
}

// SQL column/join to realize a group. Session-level groups (project/source)
// join nothing extra; message-level (model/tool/skill/subagent/hour) read from
// messages m. subagent = agent_type WHERE is_sidechain=1.
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
    case 'hour': return { col: "CAST(strftime('%H', m.ts) AS INTEGER)", where: 'AND m.ts IS NOT NULL' };
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
    case 'hour': return "CAST(strftime('%H', r.ts) AS INTEGER)";
    default: throw new Error(`explore.ts errorGroupCol: unknown group "${g as string}"`);
  }
}

export function computeExplore(q: ExploreQuery): ExploreResult {
  const cutoff = q.days ? new Date(Date.now() - q.days * 86400000).toISOString() : '';
  // null (not '') for the windowed-usage primitives — see the insights.ts comment for why.
  const cutoffIso = q.days ? cutoff : null;
  const sc = scopeClause(q.scope);
  // overlapGate (Task 2, the P0 fix — see server/windowUsage.ts): a session whose activity
  // ran INTO the window now counts, not just one that STARTED in it. `m.ts >= ?` additionally
  // restricts message-level aggregates below to messages that actually fall in-window (not
  // every message of a session that merely overlaps it) — two cutoff binds, both `cutoff`.
  const base = `JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
    WHERE ${overlapGate('s')} ${minorGate(q.scope)} ${sc.sql} AND m.ts >= ?`;
  const bind = (extra: (string|number)[] = []) => [cutoff, ...sc.params, cutoff, ...extra];
  // Token MAGNITUDE for tool/skill is always calibrated (deterministic, metric-
  // independent) so the Detail table's Tokens/$ columns are correct under every
  // metric. The `calibrated` flag below only drives the ≈ badge, so it stays
  // tied to the displayed metric — no ≈ noise when viewing errors/requests.
  const tokensAreCalibrated = CALIBRATED_GROUPS.includes(q.group);
  const calibrated = tokensAreCalibrated && (q.metric === 'tokens' || q.metric === 'spend');

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
  const g = groupExpr(q.group);
  const cellRows = db.prepare(`
    SELECT ${g.col} AS gk, COALESCE(m.model,'') AS model,
           COALESCE(SUM(m.input_tokens),0) AS input, COALESCE(SUM(m.output_tokens),0) AS output,
           COALESCE(SUM(m.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(m.cache_w5m_tokens),0) AS cw5m,
           COALESCE(SUM(m.cache_w1h_tokens),0) AS cw1h,
           COUNT(*) AS requests, COUNT(DISTINCT s.id) AS sessions
    FROM messages m ${base} ${g.where}
    GROUP BY gk, model
  `).all(...bind()) as unknown as (ModelUsageCell & { gk: string|number; model: string; requests: number; sessions: number })[];

  // Assemble rows keyed by group value.
  const rowMap = new Map<string, ExploreRow>();
  for (const c of cellRows) {
    const key = String(c.gk);
    let row = rowMap.get(key);
    if (!row) { row = { key, label: key, tokensByModel: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [] }; rowMap.set(key, row); }
    if (c.model) row.tokensByModel[c.model] = { input: c.input, output: c.output, cacheRead: c.cacheRead, cw5m: c.cw5m, cw1h: c.cw1h };
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
  const errCol = errorGroupCol(q.group);
  const errRows = db.prepare(`
    SELECT ${errCol} AS gk, substr(r.text,1,200) AS head
    FROM messages r
    JOIN messages u ON u.id = (
      SELECT MIN(u2.id) FROM messages u2
      WHERE u2.session_id = r.session_id AND u2.tool_use_id = r.tool_use_id AND u2.kind = 'tool_use'
    )
    JOIN sessions s ON s.id = r.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE r.kind = 'tool_result' AND r.text IS NOT NULL
      AND ${overlapGate('s')} ${minorGate(q.scope)} ${sc.sql} AND r.ts >= ?
  `).all(...bind()) as unknown as { gk: string|number|null; head: string }[];
  for (const e of errRows) {
    if (e.gk == null || !ERROR_RE.test(e.head)) continue;
    const r = rowMap.get(String(e.gk));
    if (r) r.errors++;
  }

  // Active ms per group value (session agent_active_ms attributed to each group
  // value present in the session — an approximation for message-level groups;
  // exact for project/source which are 1:1 with the session).
  if (q.metric === 'active') {
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
  // groupExpr('project') keys cellRows (p.name) — windowedUsage's cells carry projectId,
  // not the name. Only queried when actually needed (group='project').
  const projectNameById = q.group === 'project'
    ? new Map((db.prepare('SELECT id, name FROM projects').all() as unknown as { id: number; name: string }[]).map((p) => [p.id, p.name]))
    : new Map<number, string>();

  let usageRows: SessionUsageParsed[] = [];
  if (EXACT_USAGE_GROUPS.includes(q.group)) {
    // Token MAGNITUDE for these groups comes from windowedUsage (Task 2): per-session,
    // per-model billed cells scaled to their in-window share of per-message tokens — not
    // loadSessionUsage's raw `sessions.usage` parse, which (even after its own overlapGate
    // fix above) would over-count a spanning session's FULL billed usage instead of its
    // in-window share.
    const windowedCells = windowedUsage(db, `${minorGate(q.scope)} ${sc.sql}`, sc.params, cutoffIso);
    const acc = new Map<string, Record<string, ModelUsageCell>>();
    for (const c of windowedCells) {
      const rowKey = q.group === 'model' ? c.model : q.group === 'project' ? (projectNameById.get(c.projectId) ?? '')
        : q.group === 'session' ? c.sessionId : c.source;
      let byModel = acc.get(rowKey);
      if (!byModel) { byModel = {}; acc.set(rowKey, byModel); }
      addCell(byModel, c.model, toModelUsageCell(c.cells));
    }
    // group='session' still needs display labels (name → summary → first_prompt → id) —
    // windowedUsage doesn't carry those fields (framework-free by design, see its header),
    // so a separate lightweight metadata load resolves them below; magnitude above already
    // came from windowedCells, this is label-only.
    if (q.group === 'session') usageRows = loadSessionUsage(cutoff, sc, q.scope);
    for (const row of rowMap.values()) {
      const usageCells = acc.get(row.key);
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
      if (q.group !== 'session') row.tokensByModel = {};
    }
    // Only materialize usage-only rows (a model billed but with no per-message
    // rows) when the displayed metric actually reads token magnitude — else
    // they'd show as spurious zero-request/zero-session rows under other metrics.
    if (q.metric === 'tokens' || q.metric === 'spend') {
      for (const [k, byModel] of acc) {
        if (!rowMap.has(k)) rowMap.set(k, { key: k, label: k, tokensByModel: byModel, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [] });
      }
    }
  }

  // group=session: key IS the session id (so the client can navigate to
  // /session/:id on row click), but the raw id is a bad label — resolve the
  // display label with the same name → summary → first_prompt → id
  // precedence as the Task 13 Activity route (server/activity.ts
  // displayName), reusing the `usageRows` scan above (session ∈
  // EXACT_USAGE_GROUPS, so it's already populated whenever this runs) rather
  // than a second sessions×projects query with the same filters. Covers
  // usage-only rows materialized above too, since usageRows enumerates every
  // in-scope session regardless of whether it has usage.
  if (q.group === 'session') {
    for (const u of usageRows) {
      const r = rowMap.get(u.id);
      if (r) r.label = displayName({ id: u.id, name: u.name, summary: u.summary, first_prompt: u.first_prompt });
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
    // Calibration base + per-model split come from windowedUsage (Task 2) — the
    // authoritative sessions.usage (input+output = the Insights Tokens KPI, per the 5d
    // "narrow Insights Tokens to input+output" decision) SCALED to the in-window share,
    // NOT per-message assistant sums and not the raw unscaled billed cell — so calibrated
    // tool/skill Spend prices off the real in-window billed total at a real blended rate.
    const windowedCells = windowedUsage(db, `${minorGate(q.scope)} ${sc.sql}`, sc.params, cutoffIso);
    const modelSplit = new Map<string, { input: number; output: number }>();
    let billedAll = 0;
    for (const c of windowedCells) {
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
        r.tokensByModel = { '': { input: T, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 } };
        continue;
      }
      const tokensByModel: Record<string, ModelUsageCell> = {};
      for (const ms of modelSplitRows) {
        const msTotal = ms.input + ms.output;
        if (msTotal <= 0) continue;
        const modelTokens = Math.round(T * (msTotal / billedAll));
        const input = Math.round(modelTokens * (ms.input / msTotal));
        const output = modelTokens - input;
        tokensByModel[ms.model] = { input, output, cacheRead: 0, cw5m: 0, cw1h: 0 };
      }
      r.tokensByModel = tokensByModel;
    }
  }

  // Rank by a rough magnitude (tokens for token/spend metrics, else requests)
  // so topN + Other folding is stable regardless of the client's final metric.
  const mag = (r: ExploreRow) => {
    if (q.metric === 'requests') return r.requests;
    if (q.metric === 'sessions') return r.sessions;
    if (q.metric === 'errors') return r.errors;
    if (q.metric === 'active') return r.activeMs;
    return Object.values(r.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  };
  rows.sort((a, b) => mag(b) - mag(a));
  if (rows.length > q.topN) {
    const keep = rows.slice(0, q.topN);
    const rest = rows.slice(q.topN);
    const other: ExploreRow = { key: 'Other', label: 'Other', tokensByModel: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [], otherCount: rest.length };
    for (const r of rest) {
      other.requests += r.requests; other.errors += r.errors; other.activeMs += r.activeMs;
      other.sessions += r.sessions;
      for (const [model, u] of Object.entries(r.tokensByModel)) {
        const cur = other.tokensByModel[model] ?? { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
        cur.input += u.input; cur.output += u.output; cur.cacheRead += u.cacheRead; cur.cw5m += u.cw5m; cur.cw1h += u.cw1h;
        other.tokensByModel[model] = cur;
      }
    }
    rows = [...keep, other];
  }

  // Subgroup segments (stacked bars) — tokens per (group, subgroup) cell.
  // Skipped for calibrated (tool/skill) groups: subgroup values live on the
  // same tool_use/skill rows whose raw m.input_tokens/output_tokens are ~0
  // (the real tokens are calibrated post-hoc above, not summed per-row), so a
  // raw SUM here would render a near-zero, misleading stack. Leave segments
  // [] — the UI renders a single full-width bar when segments is empty.
  if (q.subgroup && !tokensAreCalibrated) {
    const sg = groupExpr(q.subgroup);
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
  if (q.rollup !== 'total') {
    effectiveRollup = q.rollup === 'hourly' ? 'hourly' : pickRollup(q.rollup, (r) =>
      (db.prepare(`SELECT COUNT(DISTINCT ${bucketExpr(r, 'm.ts')}) AS n FROM messages m ${base}`)
        .get(...bind()) as { n: number }).n);
    buckets = computeRollupBuckets(q, effectiveRollup, rows, { cutoff, sc, base, g });
  }

  return {
    metric: q.metric, group: q.group, subgroup: q.subgroup ?? null, calibrated, rows,
    rollup: effectiveRollup, requestedRollup: q.rollup, buckets,
  };
}

// Per-(bucket × series) aggregation for a time rollup. Metric-SPECIALIZED: only
// the dimension the chosen metric reads is populated per cell (see ExploreCell).
// `rows` supplies the series identity (its keys = topN group values + 'Other'),
// so the time-series stacks the SAME series the ranked/Detail views show, in the
// same colors. Non-topN group values fold into 'Other' per bucket.
interface RollupCtx { cutoff: string; sc: { sql: string; params: (string|number)[] }; base: string; g: { col: string; where: string }; }
function computeRollupBuckets(q: ExploreQuery, effective: ExploreRollup, rows: ExploreRow[], ctx: RollupCtx): ExploreBucket[] {
  if (effective === 'total') return [];
  const { cutoff, sc, base, g } = ctx;
  // `base` (from computeExplore) now carries overlapGate + a trailing `AND m.ts >= ?`
  // placeholder — see the computeExplore `base` comment. Bind order: cutoff (overlap),
  // sc.params (scope), cutoff again (m.ts), then any caller-supplied extras.
  const bind = (extra: (string|number)[] = []): (string|number)[] => [cutoff, ...sc.params, cutoff, ...extra];
  const bm = bucketExpr(effective, 'm.ts');
  const bs = bucketExpr(effective, 's.started_at');
  // Session scan (used by usage-sourced token magnitude + calibrated billed),
  // bucketed by started_at — a session lands wholly in one bucket. overlapGate
  // (Task 2) fixes the P0 vanishing bug for rollup token/spend charts too — a
  // spanning session is no longer dropped — but bucket PLACEMENT stays at
  // started_at (unscaled) rather than routing through bucketedUsage: that
  // primitive only supports hour/day granularity, not the weekly/monthly
  // rollups this file also serves, so per-message-scaled bucket placement for
  // this session-usage-sourced path is left as a known follow-up, not this
  // task's scope (the total/ranked `rows` above ARE fully windowedUsage-scaled).
  const sessionSql = `SELECT ${bs} AS bkt, s.id AS id, p.name AS project, s.source AS source, s.usage AS usage
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE ${overlapGate('s')} ${minorGate(q.scope)} ${sc.sql}`;

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

  if (q.metric === 'tokens' || q.metric === 'spend') {
    if (EXACT_USAGE_GROUPS.includes(q.group)) {
      // model/project/source/session magnitude from sessions.usage, bucketed by started_at.
      const srows = db.prepare(sessionSql).all(cutoff, ...sc.params) as unknown as { bkt: string; id: string; project: string; source: string; usage: string|null }[];
      for (const r of srows) {
        for (const [model, u] of Object.entries(parseUsageCells(r.usage))) {
          const gv = q.group === 'model' ? model : q.group === 'project' ? r.project
            : q.group === 'session' ? r.id : r.source;
          addCell(cell(r.bkt, seriesKeyFor(gv)).tokensByModel, model, u);
        }
      }
    } else if (CALIBRATED_GROUPS.includes(q.group)) {
      // tool/skill: calibrate PER BUCKET (char share × that bucket's billed total),
      // then split across the bucket's real models — the range-total path, partitioned.
      const charRows = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk,
        COALESCE(SUM(LENGTH(COALESCE(m.text,'')) + LENGTH(COALESCE(m.tool_input,''))),0) AS chars
        FROM messages m ${base} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; chars: number }[];
      const srows = db.prepare(sessionSql).all(cutoff, ...sc.params) as unknown as { bkt: string; usage: string|null }[];
      const billedByBucket = new Map<string, number>();
      const splitByBucket = new Map<string, Map<string, { input: number; output: number }>>();
      for (const r of srows) {
        for (const [model, u] of Object.entries(parseUsageCells(r.usage))) {
          billedByBucket.set(r.bkt, (billedByBucket.get(r.bkt) ?? 0) + u.input + u.output);
          let sp = splitByBucket.get(r.bkt); if (!sp) { sp = new Map(); splitByBucket.set(r.bkt, sp); }
          const cur = sp.get(model) ?? { input: 0, output: 0 }; cur.input += u.input; cur.output += u.output; sp.set(model, cur);
        }
      }
      const charByBucket = new Map<string, { key: string; chars: number }[]>();
      for (const cr of charRows) { const a = charByBucket.get(cr.bkt) ?? []; a.push({ key: String(cr.gk), chars: cr.chars }); charByBucket.set(cr.bkt, a); }
      for (const [bkt, arr] of charByBucket) {
        const billed = billedByBucket.get(bkt) ?? 0;
        const split = splitByBucket.get(bkt);
        for (const { key: gk, tokens: T } of calibrateByBucket(arr, billed)) {
          const tbm = cell(bkt, seriesKeyFor(gk)).tokensByModel;
          if (!split || billed <= 0) { addCell(tbm, '', { input: T, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }); continue; }
          for (const [model, v] of split) {
            const msTotal = v.input + v.output; if (msTotal <= 0) continue;
            const modelTokens = Math.round(T * (msTotal / billed));
            const input = Math.round(modelTokens * (v.input / msTotal));
            addCell(tbm, model, { input, output: modelTokens - input, cacheRead: 0, cw5m: 0, cw1h: 0 });
          }
        }
      }
    } else {
      // hour/subagent: per-message token columns are exact, bucketed by m.ts.
      const mrows = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COALESCE(m.model,'') AS model,
        COALESCE(SUM(m.input_tokens),0) AS input, COALESCE(SUM(m.output_tokens),0) AS output,
        COALESCE(SUM(m.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(m.cache_w5m_tokens),0) AS cw5m, COALESCE(SUM(m.cache_w1h_tokens),0) AS cw1h
        FROM messages m ${base} ${g.where} GROUP BY bkt, gk, model`).all(...bind()) as unknown as (ModelUsageCell & { bkt: string; gk: string|number; model: string })[];
      for (const r of mrows) {
        if (!r.model) continue;
        addCell(cell(r.bkt, seriesKeyFor(String(r.gk))).tokensByModel, r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cw5m: r.cw5m, cw1h: r.cw1h });
      }
    }
  } else if (q.metric === 'requests') {
    const rr = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COUNT(*) AS c FROM messages m ${base} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; c: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).requests += r.c;
  } else if (q.metric === 'sessions') {
    const rr = db.prepare(`SELECT ${bm} AS bkt, ${g.col} AS gk, COUNT(DISTINCT s.id) AS c FROM messages m ${base} ${g.where} GROUP BY bkt, gk`).all(...bind()) as unknown as { bkt: string; gk: string|number; c: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).sessions += r.c;
  } else if (q.metric === 'errors') {
    const errCol = errorGroupCol(q.group);
    const br = bucketExpr(effective, 'r.ts');
    const er = db.prepare(`SELECT ${br} AS bkt, ${errCol} AS gk, substr(r.text,1,200) AS head
      FROM messages r
      JOIN messages u ON u.id = (SELECT MIN(u2.id) FROM messages u2 WHERE u2.session_id = r.session_id AND u2.tool_use_id = r.tool_use_id AND u2.kind = 'tool_use')
      JOIN sessions s ON s.id = r.session_id JOIN projects p ON p.id = s.project_id
      WHERE r.kind = 'tool_result' AND r.text IS NOT NULL AND ${overlapGate('s')} ${minorGate(q.scope)} ${sc.sql} AND r.ts >= ?`).all(...bind()) as unknown as { bkt: string; gk: string|number|null; head: string }[];
    for (const e of er) { if (e.gk == null || !ERROR_RE.test(e.head)) continue; cell(String(e.bkt), seriesKeyFor(String(e.gk))).errors++; }
  } else if (q.metric === 'active') {
    const rr = db.prepare(`SELECT ${bs} AS bkt, ${g.col} AS gk, s.id AS sid, COALESCE(s.agent_active_ms,0) AS ms
      FROM messages m ${base} ${g.where} GROUP BY bkt, gk, sid`).all(...bind()) as unknown as { bkt: string; gk: string|number; sid: string; ms: number }[];
    for (const r of rr) cell(String(r.bkt), seriesKeyFor(String(r.gk))).activeMs += r.ms;
  }

  return [...grid.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, series]) => ({ bucket, label: bucketLabel(bucket), series: Object.fromEntries(series) }));
}
