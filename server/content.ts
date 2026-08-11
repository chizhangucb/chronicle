// server/content.ts
// The Content tab engine: calibrated token composition by message kind,
// tool-results-by-tool (join tool_result→tool_use on tool_use_id), skills &
// subagents (subagent token share EXACT from per-message sidechain tokens;
// skill share calibrated), and three plain-language insight callouts. All
// local, scope-parameterized.
import { db } from './db.ts';
import { scopeClause, type Scope } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';

// Inlined from src/models.ts CONTEXT_WINDOWS/contextWindowFor: importing the
// client-pure module directly trips tsc's project-boundary rules (server/
// TS project can't reference a file outside its own file list without an
// `include` pattern change) — the brief's implementer note calls this out as
// the fallback. Keep this table in sync with src/models.ts CONTEXT_WINDOWS if
// that one changes (context-window entries only; the price table stays
// client-only, never duplicated server-side).
const CONTEXT_WINDOWS: [string, number][] = [
  ['claude-fable-5', 1_000_000],
  ['claude-mythos', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-haiku', 200_000],
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude', 200_000],
  ['gpt-5', 400_000],
  ['gpt-4', 128_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['gemini', 1_000_000],
];
function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, window] of CONTEXT_WINDOWS) {
    if (m.includes(prefix)) return window;
  }
  return null;
}

export interface ContentResult {
  composition: { key: string; tokens: number }[];            // by kind, calibrated
  toolResultsByTool: { key: string; tokens: number }[];       // calibrated
  skills: { key: string; count: number; tokens: number }[];   // count exact, tokens calibrated
  subagents: { key: string; runs: number; tokens: number }[]; // both exact
  callouts: { contextPressureShare: number; subagentHeavyShare: number; cacheWarmthMinutes: number };
  calibratedTotalTokens: number;
  // Explicit contract marker so the UI can badge calibrated cells: composition,
  // toolResultsByTool, and skills[].tokens are calibrated (text-length→billed
  // estimate, see calibrate.ts); subagents[].tokens are exact (per-message
  // sidechain token columns). Always true today — every ContentResult mixes
  // at least one calibrated field.
  calibrated: boolean;
}

export function computeContent(scope: Scope, days: number | null): ContentResult {
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const sc = scopeClause(scope);
  const base = `JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}`;
  const bind = () => [cutoff, ...sc.params];

  // Calibration base = Σ in-scope sessions.usage (input+output) — the
  // authoritative billed total (= Overview / Insights Tokens KPI, which is
  // input+output per the 5d decision), NOT the per-message assistant sum
  // (which undercounts vs Overview). Same scope + days + minor gate as `base`,
  // minus the messages join. calibratedTotalTokens is this same value, so the
  // composition + Shakespeare footnote reconcile with the Insights Tokens KPI.
  const usageRows = db.prepare(`SELECT s.usage AS usage FROM sessions s
     WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}`).all(...bind()) as unknown as { usage: string|null }[];
  let billed = 0;
  for (const r of usageRows) {
    if (!r.usage) continue;
    let parsed: Record<string, { input?: number; output?: number }>;
    try { parsed = JSON.parse(r.usage) as Record<string, { input?: number; output?: number }>; } catch { continue; }
    for (const mdl of Object.keys(parsed)) billed += (parsed[mdl].input ?? 0) + (parsed[mdl].output ?? 0);
  }

  // Composition by kind (calibrated).
  const kindChars = db.prepare(`SELECT m.kind AS k, COALESCE(SUM(LENGTH(COALESCE(m.text,''))),0) AS chars
     FROM messages m ${base} GROUP BY m.kind`).all(...bind()) as unknown as { k: string; chars: number }[];
  const KINDS = ['tool_result', 'tool_use', 'user', 'assistant', 'thinking'];
  const kindBuckets = KINDS.map((k) => ({ key: k, chars: kindChars.find((c) => c.k === k)?.chars ?? 0 }));
  const composition = calibrateByBucket(kindBuckets, billed);

  // Tool results by tool (join result→use on tool_use_id).
  const toolChars = db.prepare(`
    SELECT u.tool_name AS k, COALESCE(SUM(LENGTH(COALESCE(r.text,''))),0) AS chars
    FROM messages r JOIN messages u ON u.session_id=r.session_id AND u.tool_use_id=r.tool_use_id AND u.kind='tool_use'
    JOIN sessions s ON s.id = r.session_id
    WHERE r.kind='tool_result' AND COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql} AND u.tool_name IS NOT NULL
    GROUP BY u.tool_name`).all(...bind()) as unknown as { k: string; chars: number }[];
  const toolResultsByTool = calibrateByBucket(toolChars.map((t) => ({ key: t.k, chars: t.chars })), billed)
    .filter((t) => t.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  // Skills: count exact, tokens calibrated by skill-tagged char length.
  const skillRows = db.prepare(`SELECT m.skill AS k, COUNT(*) AS count, COALESCE(SUM(LENGTH(COALESCE(m.text,''))),0) AS chars
     FROM messages m ${base} AND m.skill IS NOT NULL GROUP BY m.skill`).all(...bind()) as unknown as { k: string; count: number; chars: number }[];
  const skillTokens = new Map(calibrateByBucket(skillRows.map((r) => ({ key: r.k, chars: r.chars })), billed).map((r) => [r.key, r.tokens]));
  const skills = skillRows.map((r) => ({ key: r.k, count: r.count, tokens: skillTokens.get(r.k) ?? 0 })).sort((a, b) => b.count - a.count);

  // Subagents: runs (distinct session×agent_type) + EXACT tokens from sidechain per-message columns.
  const subRows = db.prepare(`SELECT m.agent_type AS k, COUNT(DISTINCT m.session_id) AS runs,
     COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.agent_type IS NOT NULL GROUP BY m.agent_type`).all(...bind()) as unknown as { k: string; runs: number; tokens: number }[];
  const subagents = subRows.map((r) => ({ key: r.k, runs: r.runs, tokens: r.tokens })).sort((a, b) => b.tokens - a.tokens);

  const callouts = computeCallouts(scope, cutoff, sc);

  return { composition, toolResultsByTool, skills, subagents, callouts, calibratedTotalTokens: billed, calibrated: true };
}

function computeCallouts(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }): ContentResult['callouts'] {
  const bind = () => [cutoff, ...sc.params];
  // Context-pressure: token-weighted share of sessions whose context_tokens > 70% of the model's window.
  const sessions = db.prepare(`SELECT s.context_tokens AS ctx, s.usage AS usage
     FROM sessions s WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql}`).all(...bind()) as unknown as { ctx: number|null; usage: string|null }[];
  let pressureTokens = 0, totalTokens = 0;
  for (const s of sessions) {
    let usage: Record<string, { input?: number; output?: number }> = {};
    if (s.usage) { try { usage = JSON.parse(s.usage) as Record<string, { input?: number; output?: number }>; } catch { usage = {}; } }
    const models = Object.keys(usage);
    const tok = models.reduce((n, mdl) => n + (usage[mdl].input ?? 0) + (usage[mdl].output ?? 0), 0);
    totalTokens += tok;
    const win = models.map((m) => contextWindowFor(m) ?? 0).reduce((a, b) => Math.max(a, b), 0) || 200000;
    if ((s.ctx ?? 0) > 0.7 * win) pressureTokens += tok;
  }
  // Subagent-heavy: token share from sessions where sidechain tokens > 50% of session tokens.
  const heavy = db.prepare(`SELECT s.id,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS total,
       COALESCE(SUM(CASE WHEN m.is_sidechain=1 THEN COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0) ELSE 0 END),0) AS sub
     FROM messages m JOIN sessions s ON s.id=m.session_id
     WHERE COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql} GROUP BY s.id`).all(...bind()) as unknown as { id: string; total: number; sub: number }[];
  let heavyTokens = 0, heavyTotal = 0;
  for (const h of heavy) { heavyTotal += h.total; if (h.total > 0 && h.sub > 0.5 * h.total) heavyTokens += h.total; }
  // Cache-warmth: median gap (min) between consecutive same-model assistant turns.
  const turns = db.prepare(`SELECT m.session_id AS sid, m.model AS model, m.ts AS ts FROM messages m
     JOIN sessions s ON s.id=m.session_id
     WHERE m.kind='assistant' AND m.model IS NOT NULL AND m.ts IS NOT NULL
       AND COALESCE(s.started_at,'9') >= ? AND COALESCE(s.minor,0)=0 ${sc.sql} ORDER BY m.session_id, m.ts`).all(...bind()) as unknown as { sid: string; model: string; ts: string }[];
  const gaps: number[] = [];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].sid === turns[i-1].sid && turns[i].model === turns[i-1].model) {
      const g = (new Date(turns[i].ts).getTime() - new Date(turns[i-1].ts).getTime()) / 60000;
      if (g >= 0 && g < 24 * 60) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const cacheWarmthMinutes = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 0;
  return {
    contextPressureShare: totalTokens ? Math.round((pressureTokens / totalTokens) * 100) : 0,
    subagentHeavyShare: heavyTotal ? Math.round((heavyTokens / heavyTotal) * 100) : 0,
    cacheWarmthMinutes,
  };
}
