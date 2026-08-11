// server/explore.ts
// The pivot engine. Returns metric-AGNOSTIC per-cell aggregates keyed by
// model; the CLIENT projects to the chosen metric and prices Spend via
// src/models.ts costOf (the price table lives only there — never server-side).
// Exact for model/project/source/hour/subagent groups (per-message token
// columns + tags); tool/skill × tokens are CALIBRATED via calibrate.ts and the
// result carries calibrated:true. rollup='total' only in 5e (ranked bars).
import { db } from './db.ts';
import { scopeClause, type Scope } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';

const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;

export type ExploreMetric = 'spend' | 'tokens' | 'requests' | 'active' | 'sessions' | 'errors';
export type ExploreGroup = 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour';
export interface ExploreQuery {
  scope: Scope; days: number | null;
  metric: ExploreMetric; group: ExploreGroup; subgroup?: ExploreGroup;
  rollup: 'total'; topN: number;
}
export interface ModelUsageCell { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }
export interface ExploreRow {
  key: string; label: string;
  tokensByModel: Record<string, ModelUsageCell>;
  requests: number; sessions: number; errors: number; activeMs: number;
  segments: { key: string; label: string; tokens: number }[];
}
export interface ExploreResult {
  metric: ExploreMetric; group: ExploreGroup; subgroup: ExploreGroup | null;
  calibrated: boolean; rows: ExploreRow[];
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
// stay per-message by design.
const EXACT_USAGE_GROUPS: ExploreGroup[] = ['model', 'project', 'source'];

// One parsed `sessions.usage` row's per-model billed cells, plus the session's
// project name + source so a single scan feeds model/project/source grouping.
interface SessionUsageParsed { id: string; project: string; source: string; models: Record<string, ModelUsageCell>; }
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

// Loads in-scope sessions + parsed usage, honoring the SAME scope + days +
// COALESCE(minor,0)=0 gate the message queries use.
function loadSessionUsage(cutoff: string, sc: { sql: string; params: (string|number)[] }): SessionUsageParsed[] {
  const rows = db.prepare(`
    SELECT s.id AS id, p.name AS project, s.source AS source, s.usage AS usage
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}
  `).all(cutoff, ...sc.params) as unknown as { id: string; project: string; source: string; usage: string|null }[];
  return rows.map((r) => ({ id: r.id, project: r.project, source: r.source, models: parseUsageCells(r.usage) }));
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
  const sc = scopeClause(q.scope);
  const base = `JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
    WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}`;
  const bind = (extra: (string|number)[] = []) => [cutoff, ...sc.params, ...extra];
  const calibrated = CALIBRATED_GROUPS.includes(q.group) && (q.metric === 'tokens' || q.metric === 'spend');

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
    JOIN messages u ON u.session_id = r.session_id AND u.tool_use_id = r.tool_use_id AND u.kind = 'tool_use'
    JOIN sessions s ON s.id = r.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE r.kind = 'tool_result' AND r.text IS NOT NULL
      AND COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}
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
  // tokensByModel generically).
  if (EXACT_USAGE_GROUPS.includes(q.group)) {
    const usageRows = loadSessionUsage(cutoff, sc);
    const acc = new Map<string, Record<string, ModelUsageCell>>();
    for (const u of usageRows) {
      for (const [model, cell] of Object.entries(u.models)) {
        const rowKey = q.group === 'model' ? model : q.group === 'project' ? u.project : u.source;
        let byModel = acc.get(rowKey);
        if (!byModel) { byModel = {}; acc.set(rowKey, byModel); }
        addCell(byModel, model, cell);
      }
    }
    for (const row of rowMap.values()) row.tokensByModel = acc.get(row.key) ?? {};
    for (const [k, byModel] of acc) {
      if (!rowMap.has(k)) rowMap.set(k, { key: k, label: k, tokensByModel: byModel, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [] });
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
  if (calibrated) {
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
    // Calibration base + per-model split come from the authoritative
    // sessions.usage (input+output = the Insights Tokens KPI, per the 5d
    // "narrow Insights Tokens to input+output" decision), NOT per-message
    // assistant sums — so calibrated tool/skill Spend prices off the real
    // billed totals at a real blended rate.
    const usageRows = loadSessionUsage(cutoff, sc);
    const modelSplit = new Map<string, { input: number; output: number }>();
    let billedAll = 0;
    for (const u of usageRows) {
      for (const [model, cell] of Object.entries(u.models)) {
        const cur = modelSplit.get(model) ?? { input: 0, output: 0 };
        cur.input += cell.input; cur.output += cell.output;
        modelSplit.set(model, cur);
        billedAll += cell.input + cell.output;
      }
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
    const other: ExploreRow = { key: 'Other', label: 'Other', tokensByModel: {}, requests: 0, sessions: 0, errors: 0, activeMs: 0, segments: [] };
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
  if (q.subgroup && !calibrated) {
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

  return { metric: q.metric, group: q.group, subgroup: q.subgroup ?? null, calibrated, rows };
}
