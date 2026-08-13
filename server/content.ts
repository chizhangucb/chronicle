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
//
// Each of eightHour/highAbs/highRel/autonomous carries its OWN `denom`
// (code-review fix), not a shared `stats.totalTokens` — `agent_active_ms`/
// `engaged_ms`/`context_tokens` are computed at import for claude-code
// sessions but can be genuinely NULL (a pre-migration row that hasn't been
// re-imported, or — for context_tokens specifically — a source whose parser
// doesn't populate it). Treating a NULL as 0 (`?? 0`) would silently count
// that session as "doesn't qualify" in the numerator while still counting
// its full tokens in the denominator, deflating the share without any sign
// something was missing. Instead, a session with NULL data for a given
// characteristic is excluded from BOTH that characteristic's numerator AND
// its denominator — each share is "% of the sessions that HAVE this data",
// stated as such in the UI copy, so the result stays honestly `exact: true`
// rather than quietly wrong. (workflowRuns/subagentTurns/cacheEfficiency
// don't need this: a session with no subagents or no cache reads has a
// TRUE zero there — sidechain/cache fields aren't a "not yet computed"
// signal the way active/engaged/context_tokens are.)
interface CharBucket { tokens: number; count: number; denom: number }
function newBucket(): CharBucket { return { tokens: 0, count: 0, denom: 0 }; }
interface SessionCharStats {
  totalTokens: number;
  eightHour: CharBucket;
  highAbs: CharBucket;
  highRel: CharBucket;
  autonomous: CharBucket;
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
    eightHour: newBucket(),
    highAbs: newBucket(),
    highRel: newBucket(),
    autonomous: newBucket(),
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

    // agent_active_ms / engaged_ms: NULL means "not computed for this
    // session" (pre-migration row), not "zero duration" — exclude from
    // both eightHour and autonomous entirely when either is missing.
    if (s.active != null && s.engaged != null) {
      const active = s.active;
      const engaged = s.engaged;
      stats.eightHour.denom += tok;
      if (active >= EIGHT_HOUR_ACTIVE_MS) { stats.eightHour.tokens += tok; stats.eightHour.count++; }
      stats.autonomous.denom += tok;
      if (active > 0 && engaged < AUTONOMOUS_ENGAGED_RATIO * active) { stats.autonomous.tokens += tok; stats.autonomous.count++; }
    }

    // context_tokens: NULL means "no stored context size" (non-claude-code
    // source, or a claude-code session imported before this column existed)
    // — exclude from both highAbs and highRel entirely, rather than treating
    // it as ctx=0 (which would just never qualify but still dilute the
    // denominator).
    if (s.ctx != null) {
      const ctx = s.ctx;
      stats.highAbs.denom += tok;
      if (ctx > HIGH_CONTEXT_ABS_TOKENS) { stats.highAbs.tokens += tok; stats.highAbs.count++; }
      const win = models.map((m) => contextWindowFor(m) ?? 0).reduce((a, b) => Math.max(a, b), 0) || 200000;
      stats.highRel.denom += tok;
      if (ctx > HIGH_CONTEXT_REL_RATIO * win) { stats.highRel.tokens += tok; stats.highRel.count++; }
    }

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
//
// kind IN ('assistant','tool_use'), NOT kind='assistant' alone (code-review
// fix): per-message usage attaches to the FIRST event of an assistant API
// line (`attachPerEventUsage` in the parser), and when that line's content
// starts with a tool_use block and no preceding text (a bare tool-call turn
// — common for subagents), the usage lands on a 'tool_use' kind row, not
// 'assistant'. The pre-existing `subagents` query above (no kind filter at
// all) already accounts for this; a plain 'assistant' filter here silently
// zeroed out every subagent turn whose only content was a tool call. Usage
// can ONLY ever land on 'assistant' or 'tool_use' rows (never 'tool_result'/
// 'user' — those come from a separate JSONL line type that never carries
// `.message.usage`), so this IN-list is exactly equivalent to "no kind
// filter" for token attribution while still excluding tool_result/user rows
// from the TURN COUNT (an unfiltered count would inflate "turns" into a raw
// message-row count, since one API turn's tool_result confirmation is a
// separate row that never carries its own tokens).
function computeCharacteristics(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }, stats: SessionCharStats): Characteristic[] {
  const bind = () => [cutoff, ...sc.params];
  const base = `JOIN sessions s ON s.id = m.session_id
    WHERE COALESCE(s.started_at,'9') >= ? ${minorGate(scope)} ${sc.sql}`;
  // workflowRuns/subagentTurns denominator is stats.totalTokens (ALL in-scope
  // sessions) — sidechain fields aren't a "not yet computed" signal like
  // active/context (see the SessionCharStats comment), so no sessions need
  // excluding here.
  const share = (tok: number) => (stats.totalTokens ? Math.round((tok / stats.totalTokens) * 100) : 0);
  // eightHour/highAbs/highRel/autonomous each divide by THEIR OWN bucket's
  // `denom` (Σ tokens of only the sessions that HAVE the underlying data) —
  // NOT stats.totalTokens (code-review fix, see SessionCharStats comment).
  const bucketShare = (b: CharBucket) => (b.denom ? Math.round((b.tokens / b.denom) * 100) : 0);

  const wf = db.prepare(`SELECT COUNT(DISTINCT m.workflow_id) AS runs,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind IN ('assistant','tool_use') AND m.workflow_id IS NOT NULL`)
    .get(...bind()) as unknown as { runs: number; tokens: number };

  const sub = db.prepare(`SELECT COUNT(*) AS turns,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind IN ('assistant','tool_use')`)
    .get(...bind()) as unknown as { turns: number; tokens: number };

  const cacheDenom = stats.cacheRead + stats.cacheInput;

  return [
    { key: 'eightHourSessions', share: bucketShare(stats.eightHour), count: stats.eightHour.count, exact: true },
    { key: 'workflowRuns', share: share(wf.tokens), count: wf.runs, exact: true },
    { key: 'subagentTurns', share: share(sub.tokens), count: sub.turns, exact: true },
    { key: 'highContextAbs', share: bucketShare(stats.highAbs), count: stats.highAbs.count, exact: true },
    { key: 'highContextRel', share: bucketShare(stats.highRel), count: stats.highRel.count, exact: true },
    { key: 'cacheEfficiency', share: cacheDenom ? Math.round((stats.cacheRead / cacheDenom) * 100) : 0, count: stats.cacheSessionCount, exact: true },
    { key: 'autonomousShare', share: bucketShare(stats.autonomous), count: stats.autonomous.count, exact: true },
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
    // Same bucket, same denom as the highContextRel characteristic (see the
    // SessionCharStats comment) — sessions without a stored context_tokens
    // value are excluded from both numerator and denominator here too, so
    // this callout and that characteristic can never silently disagree.
    contextPressureShare: stats.highRel.denom ? Math.round((stats.highRel.tokens / stats.highRel.denom) * 100) : 0,
    subagentHeavyShare: heavyTotal ? Math.round((heavyTokens / heavyTotal) * 100) : 0,
    cacheWarmthMinutes,
  };
}
