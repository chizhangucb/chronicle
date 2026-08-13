// server/content.ts
// The Content tab engine: calibrated token composition by message kind,
// tool-results-by-tool (join tool_result→tool_use on tool_use_id), skills &
// subagents (subagent token share EXACT from per-message sidechain tokens;
// skill share calibrated), and three plain-language insight callouts. All
// local, scope-parameterized.
import { db } from './db.ts';
import { scopeClause, minorGate, type Scope } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';
// Context-window table is a model CONSTANT (max tokens), not a price, so it's
// shared between server and client via `shared/contextWindows.ts` (the price
// table stays client-only in src/models.ts — see that file's comment). This
// replaces a former hand-inlined copy that had to be kept in sync manually.
import { contextWindowFor } from '../shared/contextWindows.ts';

// Named thresholds for the 7 usage characteristics (spec §2.5). Every "share"
// below is a TOKEN share of Σ in-scope sessions.usage — the same convention
// the callouts above already use (contextPressureShare / subagentHeavyShare
// weight by token spend, not raw session/message counts), so a marathon
// session with a lot of usage moves the needle more than a two-message blip.
const EIGHT_HOUR_ACTIVE_MS = 8 * 60 * 60 * 1000;
const HIGH_CONTEXT_ABS_TOKENS = 150_000;
// >70% of the model's context window. NOT confirmed as Claude Code's
// auto-compact trigger — the C4 validation (2026-08-13) fetched the current
// Claude Code docs (docs.anthropic.com/en/docs/claude-code → costs,
// model-config) and found no published fixed percentage: the 1M-context
// default (Sonnet 5 / Fable 5) auto-compacts at ~967K tokens (~96.7%), and
// the docs explicitly decline to publish a default for the 200K window
// ("the exact trigger threshold ... has shifted across releases"). So 70%
// here is Chronicle's OWN heuristic "getting pricey" threshold, not a
// documented auto-compact boundary — the UI copy must say so (see
// ContentTab.tsx's InfoTip text for this characteristic).
const HIGH_CONTEXT_REL_RATIO = 0.7;
// A session counts as "ran mostly unattended" when its engaged (wall-clock)
// time is under a quarter of its agent-active time — i.e. you were only
// around for a small slice of the time the agent was actually working.
const AUTONOMOUS_ENGAGED_RATIO = 0.25;

export interface Characteristic {
  key: 'eightHourSessions' | 'workflowRuns' | 'subagentTurns' | 'highContextAbs'
     | 'highContextRel' | 'cacheEfficiency' | 'autonomousShare';
  share: number;      // 0-100, rounded token share of in-scope billed usage
  count?: number;      // qualifying session/run/turn count, when meaningful
  exact: boolean;
}

export interface ContentResult {
  composition: { key: string; tokens: number }[];            // by kind, calibrated
  toolResultsByTool: { key: string; tokens: number }[];       // calibrated
  skills: { key: string; count: number; tokens: number }[];   // count exact, tokens calibrated
  subagents: { key: string; runs: number; tokens: number }[]; // both exact
  callouts: { contextPressureShare: number; subagentHeavyShare: number; cacheWarmthMinutes: number };
  // The 7 independent usage characteristics (spec §2.5) — NOT a breakdown of
  // one another (they can overlap: a session can be both an eightHourSessions
  // AND a highContextRel session). Every numerator here comes from
  // session-level columns (sessions.usage/agent_active_ms/engaged_ms/
  // context_tokens, all computed/stored at import time) or EXACT per-message
  // sidechain token columns (workflow/subagent runs) — never from the
  // message-text-length calibration `calibrateByBucket` uses elsewhere in
  // this file, so every entry is `exact: true` today. Kept as a real boolean
  // per entry (not a blanket constant) so a future characteristic computed by
  // calibration can flip to `exact: false` without changing the contract.
  characteristics: Characteristic[];
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
    WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql}`;
  const bind = () => [cutoff, ...sc.params];

  // Calibration base = Σ in-scope sessions.usage (input+output) — the
  // authoritative billed total (= Overview / Insights Tokens KPI, which is
  // input+output per the 5d decision), NOT the per-message assistant sum
  // (which undercounts vs Overview). Same scope + days + minor gate as `base`,
  // minus the messages join. calibratedTotalTokens is this same value, so the
  // composition + Shakespeare footnote reconcile with the Insights Tokens KPI.
  const usageRows = db.prepare(`SELECT s.usage AS usage FROM sessions s
     WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql}`).all(...bind()) as unknown as { usage: string|null }[];
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

  // ALL-content char total = Σ over ALL message kinds (the same denominator
  // composition effectively uses). Tool-results and skills are normalized
  // against THIS, so each represents its TRUE fraction of `billed` — not its
  // share of a self-selected subpool (the old calibrateByBucket(...) over only
  // tool-result / skill buckets summed to the ENTIRE billed total, implying
  // tool-results ≈ 100% of usage). Σ toolResultsByTool now stays ≤ the
  // composition tool_result bucket (unpaired results simply aren't attributed).
  const allContentChars = kindBuckets.reduce((n, b) => n + b.chars, 0);
  const shareTokens = (chars: number) => (allContentChars > 0 ? Math.round((chars / allContentChars) * billed) : 0);

  // Tool results by tool (join result→use on tool_use_id).
  const toolChars = db.prepare(`
    SELECT u.tool_name AS k, COALESCE(SUM(LENGTH(COALESCE(r.text,''))),0) AS chars
    FROM messages r JOIN messages u ON u.id = (
      SELECT MIN(u2.id) FROM messages u2
      WHERE u2.session_id = r.session_id AND u2.tool_use_id = r.tool_use_id AND u2.kind = 'tool_use'
    )
    JOIN sessions s ON s.id = r.session_id
    WHERE r.kind='tool_result' AND COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql} AND u.tool_name IS NOT NULL
    GROUP BY u.tool_name`).all(...bind()) as unknown as { k: string; chars: number }[];
  const toolResultsByTool = toolChars.map((t) => ({ key: t.k, tokens: shareTokens(t.chars) }))
    .filter((t) => t.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  // Skills: count exact, tokens = true fraction of billed (share of ALL content).
  const skillRows = db.prepare(`SELECT m.skill AS k, COUNT(*) AS count, COALESCE(SUM(LENGTH(COALESCE(m.text,''))),0) AS chars
     FROM messages m ${base} AND m.skill IS NOT NULL GROUP BY m.skill`).all(...bind()) as unknown as { k: string; count: number; chars: number }[];
  const skills = skillRows.map((r) => ({ key: r.k, count: r.count, tokens: shareTokens(r.chars) })).sort((a, b) => b.count - a.count);

  // Subagents: runs (distinct session×agent_type) + EXACT tokens from sidechain per-message columns.
  const subRows = db.prepare(`SELECT m.agent_type AS k, COUNT(DISTINCT m.session_id) AS runs,
     COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.agent_type IS NOT NULL GROUP BY m.agent_type`).all(...bind()) as unknown as { k: string; runs: number; tokens: number }[];
  const subagents = subRows.map((r) => ({ key: r.k, runs: r.runs, tokens: r.tokens })).sort((a, b) => b.tokens - a.tokens);

  const stats = computeSessionCharStats(scope, cutoff, sc);
  const callouts = computeCallouts(scope, cutoff, sc, stats);
  const characteristics = computeCharacteristics(scope, cutoff, sc, stats);

  return { composition, toolResultsByTool, skills, subagents, callouts, characteristics, calibratedTotalTokens: billed, calibrated: true };
}

// One pass over in-scope sessions' `usage`/`context_tokens`/`agent_active_ms`/
// `engaged_ms` columns, computing every session-level aggregate the callouts
// AND the characteristics block need. Shared so "> 70% of the model's context
// window" is computed exactly ONCE (both the contextPressureShare callout and
// the highContextRel characteristic read off the same numbers here — they are
// deliberately the same underlying metric surfaced in two different UI
// shapes, a narrative sentence vs. a scannable stat row; sharing the
// computation keeps them from ever silently disagreeing).
interface SessionCharStats {
  totalTokens: number;
  eightHour: { tokens: number; count: number };
  highAbs: { tokens: number; count: number };
  highRel: { tokens: number; count: number };
  autonomous: { tokens: number; count: number };
  cacheRead: number;
  cacheInput: number;
  cacheSessionCount: number;
}
function computeSessionCharStats(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }): SessionCharStats {
  const bind = () => [cutoff, ...sc.params];
  const sessions = db.prepare(`SELECT s.context_tokens AS ctx, s.usage AS usage,
       s.agent_active_ms AS active, s.engaged_ms AS engaged
     FROM sessions s WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql}`).all(...bind()) as unknown as
     { ctx: number|null; usage: string|null; active: number|null; engaged: number|null }[];
  const stats: SessionCharStats = {
    totalTokens: 0,
    eightHour: { tokens: 0, count: 0 },
    highAbs: { tokens: 0, count: 0 },
    highRel: { tokens: 0, count: 0 },
    autonomous: { tokens: 0, count: 0 },
    cacheRead: 0,
    cacheInput: 0,
    cacheSessionCount: 0,
  };
  for (const s of sessions) {
    let usage: Record<string, { input?: number; output?: number; cacheRead?: number }> = {};
    if (s.usage) { try { usage = JSON.parse(s.usage) as Record<string, { input?: number; output?: number; cacheRead?: number }>; } catch { usage = {}; } }
    const models = Object.keys(usage);
    const tok = models.reduce((n, mdl) => n + (usage[mdl].input ?? 0) + (usage[mdl].output ?? 0), 0);
    stats.totalTokens += tok;

    const active = s.active ?? 0;
    const engaged = s.engaged ?? 0;
    if (active >= EIGHT_HOUR_ACTIVE_MS) { stats.eightHour.tokens += tok; stats.eightHour.count++; }
    if (active > 0 && engaged < AUTONOMOUS_ENGAGED_RATIO * active) { stats.autonomous.tokens += tok; stats.autonomous.count++; }

    const ctx = s.ctx ?? 0;
    if (ctx > HIGH_CONTEXT_ABS_TOKENS) { stats.highAbs.tokens += tok; stats.highAbs.count++; }
    const win = models.map((m) => contextWindowFor(m) ?? 0).reduce((a, b) => Math.max(a, b), 0) || 200000;
    if (ctx > HIGH_CONTEXT_REL_RATIO * win) { stats.highRel.tokens += tok; stats.highRel.count++; }

    let sessCacheRead = 0;
    for (const mdl of models) sessCacheRead += usage[mdl].cacheRead ?? 0;
    if (sessCacheRead > 0) stats.cacheSessionCount++;
    stats.cacheRead += sessCacheRead;
    stats.cacheInput += models.reduce((n, mdl) => n + (usage[mdl].input ?? 0), 0);
  }
  return stats;
}

// The 7 independent usage characteristics (spec §2.5). eightHourSessions /
// highContextAbs / highContextRel / autonomousShare / cacheEfficiency all
// read off the shared session-level pass above (`stats`); workflowRuns and
// subagentTurns query the exact per-message sidechain token columns directly
// (sidechain usage is real spend already folded into sessions.usage — see
// the parser's "sidechain usage INCLUDED" comment — so these shares are
// directly comparable against stats.totalTokens without any calibration).
function computeCharacteristics(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }, stats: SessionCharStats): Characteristic[] {
  const bind = () => [cutoff, ...sc.params];
  const base = `JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql}`;
  const share = (tok: number) => (stats.totalTokens ? Math.round((tok / stats.totalTokens) * 100) : 0);

  const wf = db.prepare(`SELECT COUNT(DISTINCT m.workflow_id) AS runs,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind='assistant' AND m.workflow_id IS NOT NULL`)
    .get(...bind()) as unknown as { runs: number; tokens: number };

  const sub = db.prepare(`SELECT COUNT(*) AS turns,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind='assistant'`)
    .get(...bind()) as unknown as { turns: number; tokens: number };

  const cacheDenom = stats.cacheRead + stats.cacheInput;

  return [
    { key: 'eightHourSessions', share: share(stats.eightHour.tokens), count: stats.eightHour.count, exact: true },
    { key: 'workflowRuns', share: share(wf.tokens), count: wf.runs, exact: true },
    { key: 'subagentTurns', share: share(sub.tokens), count: sub.turns, exact: true },
    { key: 'highContextAbs', share: share(stats.highAbs.tokens), count: stats.highAbs.count, exact: true },
    { key: 'highContextRel', share: share(stats.highRel.tokens), count: stats.highRel.count, exact: true },
    { key: 'cacheEfficiency', share: cacheDenom ? Math.round((stats.cacheRead / cacheDenom) * 100) : 0, count: stats.cacheSessionCount, exact: true },
    { key: 'autonomousShare', share: share(stats.autonomous.tokens), count: stats.autonomous.count, exact: true },
  ];
}

function computeCallouts(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }, stats: SessionCharStats): ContentResult['callouts'] {
  const bind = () => [cutoff, ...sc.params];
  // Subagent-heavy: token share from sessions where sidechain tokens > 50% of session tokens.
  const heavy = db.prepare(`SELECT s.id,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS total,
       COALESCE(SUM(CASE WHEN m.is_sidechain=1 THEN COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0) ELSE 0 END),0) AS sub
     FROM messages m JOIN sessions s ON s.id=m.session_id
     WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql} GROUP BY s.id`).all(...bind()) as unknown as { id: string; total: number; sub: number }[];
  let heavyTokens = 0, heavyTotal = 0;
  for (const h of heavy) { heavyTotal += h.total; if (h.total > 0 && h.sub > 0.5 * h.total) heavyTokens += h.total; }
  // Cache-warmth: median gap (min) between consecutive same-model assistant turns.
  const turns = db.prepare(`SELECT m.session_id AS sid, m.model AS model, m.ts AS ts FROM messages m
     JOIN sessions s ON s.id=m.session_id
     WHERE m.kind='assistant' AND m.model IS NOT NULL AND m.ts IS NOT NULL
       AND COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql} ORDER BY m.session_id, m.ts`).all(...bind()) as unknown as { sid: string; model: string; ts: string }[];
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
    contextPressureShare: stats.totalTokens ? Math.round((stats.highRel.tokens / stats.totalTokens) * 100) : 0,
    subagentHeavyShare: heavyTotal ? Math.round((heavyTokens / heavyTotal) * 100) : 0,
    cacheWarmthMinutes,
  };
}
