// server/content.ts
// The Content tab engine: calibrated token composition by message kind,
// tool-results-by-tool (join tool_result→tool_use on tool_use_id), skills &
// subagents (subagent token share EXACT from per-message sidechain tokens;
// skill share calibrated), and a scope-tagged "usage characteristics" list
// (D4, feedback-round Task 12) — 7 token-share stats at all/project scope,
// 6 absolute session facts at session scope (see the ContentResult/
// Characteristic doc comments below). All local, scope-parameterized.
import { db } from './db.ts';
import { scopeClause, minorGate, type Scope } from './scope.ts';
import { calibrateByBucket } from './calibrate.ts';
import { overlapGate, windowedUsage } from './windowUsage.ts';
// Context-window table is a model CONSTANT (max tokens), not a price, so it's
// shared between server and client via `shared/contextWindows.ts` (the price
// table stays client-only in src/models.ts — see that file's comment). This
// replaces a former hand-inlined copy that had to be kept in sync manually.
import { contextWindowFor } from '../shared/contextWindows.ts';

// Named thresholds for the usage-characteristics block (spec §2.5, reshaped
// by feedback-round D4). Every "share" at all/project scope is a TOKEN share
// of Σ in-scope sessions.usage, so a marathon session with a lot of usage
// moves the needle more than a two-message blip.
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

// D4 (feedback-round Task 12): the old separate "What your usage says"
// narrative callouts (contextPressureShare / subagentHeavyShare /
// cacheWarmthMinutes, computed by the now-removed computeCallouts) surfaced
// the SAME numbers the characteristics block already carried (contextPressureShare
// was literally highRel's share/denom, see the old computeCallouts) — merged
// into ONE section: the narrative framing now lives in the `why` text of the
// top characteristic rows, not a second parallel computation.
// cacheWarmthMinutes (a median-gap-in-minutes stat, not a token share) had no
// characteristics-list analog and is dropped rather than force-fit into the
// share-shaped contract.
//
// Every field the client needs to RENDER a row (label/why/info) now travels on
// the Characteristic itself — the client maps over the array generically
// (see src/ContentTab.tsx), it does not switch on `key`. `format` says how to
// read `value` (and the optional secondary `value2`, always a percent — used
// only by session-scope `peakContextTokens`, "N tokens (M% of window)").
export type CharacteristicFormat = 'percent' | 'tokens' | 'hours';

export interface Characteristic {
  key: string;
  label: string;   // bold lead-in text, after the formatted value (i18n key = literal English)
  why: string;      // one-line plain-language explainer
  info: string;      // full-sentence InfoTip copy
  format: CharacteristicFormat;
  value: number;      // the leading number, read per `format`
  value2?: number;    // secondary percent value, e.g. peakContextTokens' "% of window"
  warn?: boolean;      // visual emphasis (mirrors the old contextPressureShare >=40% "warn" callout)
  count?: number;      // qualifying session/run/turn count, when meaningful
  countOne?: string;    // pluralize() singular label for `count`
  countMany?: string;   // pluralize() plural label for `count`
  exact: boolean;
}

export interface ContentResult {
  composition: { key: string; tokens: number }[];            // by kind, calibrated
  toolResultsByTool: { key: string; tokens: number }[];       // calibrated
  skills: { key: string; count: number; tokens: number }[];   // count exact, tokens calibrated
  subagents: { key: string; runs: number; tokens: number }[]; // both exact
  // Scope-tagged per-scope set: at 'all'/'project' scope, the 7 token-share
  // characteristics (spec §2.5) — NOT a breakdown of one another (they can
  // overlap: a session can be both an eightHourSessions AND a highContextRel
  // session). At 'session' scope, the four threshold predicates that collapse
  // to a meaningless 0%/100% at N=1 (eightHourSessions/highContextAbs/
  // highContextRel/autonomousShare) are replaced by absolute session facts
  // (marathon badge, peak context tokens + % of window, unattended ratio);
  // cacheEfficiency/subagentTurns/workflowRuns stay (real, non-binary
  // percentages even for one session). Every numerator comes from session-level
  // columns (sessions.usage/agent_active_ms/engaged_ms/context_tokens, computed
  // at import time) or EXACT per-message sidechain token columns — never from
  // the message-text-length calibration `calibrateByBucket` uses elsewhere in
  // this file, so every entry is `exact: true` today.
  characteristicsScope: 'all' | 'project' | 'session';
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
  // null (not '') for the windowed-usage primitives — see server/insights.ts's comment on
  // the same pattern for why (cutoffIso===null is windowedUsage's "All window" signal).
  const cutoffIso = days ? cutoff : null;
  const sc = scopeClause(scope);
  // overlapGate (Task 2, the P0 fix — see server/windowUsage.ts): a session whose activity
  // ran INTO the window now counts, not just one that STARTED in it. `m.ts >= ?` additionally
  // restricts message-joined queries below to messages that actually fall in-window.
  const base = `JOIN sessions s ON s.id = m.session_id
    WHERE ${overlapGate('s')} ${minorGate(scope)} ${sc.sql} AND m.ts >= ?`;
  const bind = () => [cutoff, ...sc.params, cutoff];

  // Calibration base = Σ in-scope sessions.usage (input+output), windowed: each
  // session's billed cell scaled to its in-window share of per-message tokens, via
  // windowedUsage — the authoritative billed total (= Overview / Insights Tokens KPI, which
  // is input+output per the 5d decision), NOT the per-message assistant sum (which
  // undercounts vs Overview) and NOT a raw unscaled sessions.usage sum (which would
  // over-count a session spanning the window boundary). calibratedTotalTokens is this same
  // value, so the composition + Shakespeare footnote reconcile with the Insights Tokens KPI.
  const windowedCells = windowedUsage(db, `${minorGate(scope)} ${sc.sql}`, sc.params, cutoffIso);
  let billed = 0;
  for (const c of windowedCells) billed += c.cells.input + c.cells.output;

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
    WHERE r.kind='tool_result' AND ${overlapGate('s')} ${minorGate(scope)} ${sc.sql} AND u.tool_name IS NOT NULL AND r.ts >= ?
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
  const characteristics = computeCharacteristics(scope, cutoff, sc, stats);

  return {
    composition, toolResultsByTool, skills, subagents,
    characteristicsScope: scope.type, characteristics,
    calibratedTotalTokens: billed, calibrated: true,
  };
}

// One pass over in-scope sessions' `usage`/`context_tokens`/`agent_active_ms`/
// `engaged_ms` columns, computing every session-level aggregate the
// characteristics block needs. Also carries `single`, the one raw session
// row (context/active/engaged/window/cache/tokens, unaggregated) used ONLY
// at session scope — the D4 session-facts set (marathon/peak-context/
// unattended-ratio) reports absolute numbers for the one session in scope,
// not a bucket share, so it reads straight off this raw row rather than the
// eightHour/highAbs/highRel/autonomous buckets below (those buckets stay for
// all/project scope, where they remain meaningful token shares across many
// sessions).
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
// Raw, unaggregated facts for the ONE session in a session-scope query — see
// the D4 comment above computeSessionCharStats.
interface SingleSessionFacts {
  ctx: number | null;
  active: number | null;
  engaged: number | null;
  win: number;        // this session's model's context window (max over its models, 200k fallback)
  cacheRead: number;
  cacheInput: number;
  totalTokens: number;
}
interface SessionCharStats {
  totalTokens: number;
  eightHour: CharBucket;
  highAbs: CharBucket;
  highRel: CharBucket;
  autonomous: CharBucket;
  cacheRead: number;
  cacheInput: number;
  cacheSessionCount: number;
  single: SingleSessionFacts | null;
}
function computeSessionCharStats(scope: Scope, cutoff: string, sc: { sql: string; params: (string|number)[] }): SessionCharStats {
  const bind = () => [cutoff, ...sc.params];
  // Session-level (no messages join) — overlapGate is the whole fix here: a
  // session's characteristics (8h-active, high-context, autonomous, …) describe the WHOLE
  // session, not an in-window fraction, so there's no per-message `m.ts >= cutoff` to add —
  // just the same overlap-vs-drop inclusion fix every other gate in this file gets.
  const sessions = db.prepare(`SELECT s.context_tokens AS ctx, s.usage AS usage,
       s.agent_active_ms AS active, s.engaged_ms AS engaged
     FROM sessions s WHERE ${overlapGate('s')} ${minorGate(scope)} ${sc.sql}`).all(...bind()) as unknown as
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
    single: null,
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
    const win = models.map((m) => contextWindowFor(m) ?? 0).reduce((a, b) => Math.max(a, b), 0) || 200000;
    if (s.ctx != null) {
      const ctx = s.ctx;
      stats.highAbs.denom += tok;
      if (ctx > HIGH_CONTEXT_ABS_TOKENS) { stats.highAbs.tokens += tok; stats.highAbs.count++; }
      stats.highRel.denom += tok;
      if (ctx > HIGH_CONTEXT_REL_RATIO * win) { stats.highRel.tokens += tok; stats.highRel.count++; }
    }

    let sessCacheRead = 0;
    for (const mdl of models) sessCacheRead += usage[mdl].cacheRead ?? 0;
    if (sessCacheRead > 0) stats.cacheSessionCount++;
    const sessCacheInput = models.reduce((n, mdl) => n + (usage[mdl].input ?? 0), 0);
    stats.cacheRead += sessCacheRead;
    stats.cacheInput += sessCacheInput;

    // `single`: the raw facts for THIS session, overwritten each iteration —
    // only meaningful (and only read) when the caller is session-scoped, in
    // which case `sessions` has exactly one row.
    stats.single = { ctx: s.ctx, active: s.active, engaged: s.engaged, win, cacheRead: sessCacheRead, cacheInput: sessCacheInput, totalTokens: tok };
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
  // overlapGate + trailing `m.ts >= ?` — same fix as computeContent's own `base` (these
  // workflowRuns/subagentTurns queries are message-level, unlike computeSessionCharStats).
  const bind = () => [cutoff, ...sc.params, cutoff];
  const base = `JOIN sessions s ON s.id = m.session_id
    WHERE ${overlapGate('s')} ${minorGate(scope)} ${sc.sql} AND m.ts >= ?`;

  const wf = db.prepare(`SELECT COUNT(DISTINCT m.workflow_id) AS runs,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind IN ('assistant','tool_use') AND m.workflow_id IS NOT NULL`)
    .get(...bind()) as unknown as { runs: number; tokens: number };

  const sub = db.prepare(`SELECT COUNT(*) AS turns,
       COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0) AS tokens
     FROM messages m ${base} AND m.is_sidechain=1 AND m.kind IN ('assistant','tool_use')`)
    .get(...bind()) as unknown as { turns: number; tokens: number };

  return scope.type === 'session'
    ? sessionFacts(stats, wf, sub)
    : allProjectShares(stats, wf, sub);
}

// ---- all/project scope: 7 token-share characteristics (spec §2.5) ----
// D4: highContextRel and subagentTurns lead the list (the old narrative
// callouts' framing, merged into their `why` text below) instead of the
// former alphabetical-ish order; the remaining 5 keep their original math
// unchanged.
function allProjectShares(stats: SessionCharStats, wf: { runs: number; tokens: number }, sub: { turns: number; tokens: number }): Characteristic[] {
  // workflowRuns/subagentTurns denominator is stats.totalTokens (ALL in-scope
  // sessions) — sidechain fields aren't a "not yet computed" signal like
  // active/context (see the SessionCharStats comment), so no sessions need
  // excluding here.
  const share = (tok: number) => (stats.totalTokens ? Math.round((tok / stats.totalTokens) * 100) : 0);
  // eightHour/highAbs/highRel/autonomous each divide by THEIR OWN bucket's
  // `denom` (Σ tokens of only the sessions that HAVE the underlying data) —
  // NOT stats.totalTokens (code-review fix, see SessionCharStats comment).
  const bucketShare = (b: CharBucket) => (b.denom ? Math.round((b.tokens / b.denom) * 100) : 0);
  const cacheDenom = stats.cacheRead + stats.cacheInput;
  const highRelShare = bucketShare(stats.highRel);
  const subagentShare = share(sub.tokens);

  return [
    {
      key: 'highContextRel', format: 'percent', value: highRelShare, count: stats.highRel.count, exact: true,
      warn: highRelShare >= 40,
      label: "of usage ran past 70% of the model's context window",
      why: "Chronicle's own heuristic threshold, not a documented Claude Code auto-compact trigger — long sessions are pricier even when cached; splitting tasks or compacting mid-task cuts cache-write spend.",
      info: "Compares each session's stored context size against its model's context window. 70% is a heuristic threshold Chronicle chose to flag rising cost, not a documented auto-compact point — Claude Code doesn't publish a fixed default for the 200K window, and the 1M window auto-compacts around 97%, well past 70%. Sessions with no stored context size are left out of this share entirely, on both sides of the percentage.",
      countOne: 'session', countMany: 'sessions',
    },
    {
      key: 'subagentTurns', format: 'percent', value: subagentShare, count: sub.turns, exact: true,
      label: 'of usage came from subagent turns',
      why: "Work delegated to Task-launched subagents rather than answered on the main thread — each subagent pays its own context, worth it for parallel work but worth watching on simple tasks.",
      info: "Counts every reply a subagent produced, exact from Chronicle's per-message sidechain token columns — includes both workflow and standalone subagent runs.",
      countOne: 'subagent turn', countMany: 'subagent turns',
    },
    {
      key: 'eightHourSessions', format: 'percent', value: bucketShare(stats.eightHour), count: stats.eightHour.count, exact: true,
      label: 'of usage came from marathon sessions (8h+ active)',
      why: 'Sessions where the agent was actively working — not just open — for 8 hours or more.',
      info: 'Agent-active time sums every gap between messages except the ones spent waiting on you to type a prompt, capped at 10 minutes per gap unless a long-running tool call fills it — a session counts here once that total reaches 8 hours. Sessions without a stored duration (not yet re-synced) are left out of this share entirely, on both sides of the percentage.',
      countOne: 'marathon session', countMany: 'marathon sessions',
    },
    {
      key: 'workflowRuns', format: 'percent', value: share(wf.tokens), count: wf.runs, exact: true,
      label: 'of usage ran inside a multi-agent workflow',
      why: 'Tokens spent on groups of subagents launched together to divide one task.',
      info: "A workflow run is a group of subagents nested under one shared workflow folder — this is their exact share of billed tokens, not a text-length estimate.",
      countOne: 'workflow run', countMany: 'workflow runs',
    },
    {
      key: 'highContextAbs', format: 'percent', value: bucketShare(stats.highAbs), count: stats.highAbs.count, exact: true,
      label: 'of usage ran above 150k context tokens',
      why: "Sessions carrying a large context regardless of the model's window size.",
      info: "Flags sessions whose stored context size passed 150,000 tokens — an absolute cutoff, independent of which model or context-window size was in use. Sessions with no stored context size (some non-Claude-Code sources, or an import from before context tracking was added) are left out of this share entirely, on both sides of the percentage.",
      countOne: 'session', countMany: 'sessions',
    },
    {
      key: 'cacheEfficiency', format: 'percent', value: cacheDenom ? Math.round((stats.cacheRead / cacheDenom) * 100) : 0, count: stats.cacheSessionCount, exact: true,
      label: 'of input tokens were served from cache',
      why: 'Higher is cheaper — a cache read costs a fraction of a fresh input token.',
      info: "The share of input-side tokens (fresh input plus cache reads) that came from cache reads, computed directly from each session's billed usage.",
      countOne: 'session with cache activity', countMany: 'sessions with cache activity',
    },
    {
      key: 'autonomousShare', format: 'percent', value: bucketShare(stats.autonomous), count: stats.autonomous.count, exact: true,
      label: 'of usage ran mostly unattended',
      why: 'Engaged (wall-clock) time stayed under a quarter of active time — the agent worked largely without you watching.',
      info: 'Flags sessions where engaged time (your wall-clock presence) is under 25% of agent-active time (the agent\'s working time) — for example, a long build or tool call that ran while you stepped away. Sessions without stored duration data (not yet re-synced) are left out of this share entirely, on both sides of the percentage.',
      countOne: 'session', countMany: 'sessions',
    },
  ];
}

// ---- session scope: absolute session facts, not threshold predicates ----
// eightHourSessions/highContextAbs/highContextRel/autonomousShare all divide a
// bucket by ITSELF at N=1 (this one session either has the qualifying property
// or doesn't), so they always read exactly 0% or 100% — not useful. Replaced
// with the underlying absolute numbers: marathon badge (real active hours vs
// the 8h line), peak context tokens + % of the model's window (folds the old
// abs/rel pair into one richer fact), and unattended ratio (engaged as a share
// of active, not a binary "did it cross 25%" flag). cacheEfficiency,
// subagentTurns, and workflowRuns are already real, non-binary percentages for
// a single session (a session's own subagent-token fraction is meaningful on
// its own), so they carry over unchanged from the all/project set.
function sessionFacts(stats: SessionCharStats, wf: { runs: number; tokens: number }, sub: { turns: number; tokens: number }): Characteristic[] {
  const single = stats.single;
  if (!single) return [];
  const { ctx, active, engaged, win, cacheRead, cacheInput, totalTokens } = single;
  const share = (tok: number) => (totalTokens ? Math.round((tok / totalTokens) * 100) : 0);
  const facts: Characteristic[] = [];

  if (active != null) {
    const hours = Math.round((active / 3600000) * 10) / 10;
    const crossed = active >= EIGHT_HOUR_ACTIVE_MS;
    facts.push({
      key: 'marathonBadge', format: 'hours', value: hours, count: crossed ? 1 : 0, exact: true, warn: crossed,
      label: crossed ? 'active — crossed the 8-hour marathon threshold' : 'active this session (marathon threshold: 8h)',
      why: 'Agent-active time sums every gap between messages except the ones spent waiting on you to type a prompt, capped at 10 minutes per gap unless a long-running tool call fills it.',
      info: 'The same agent-active computation used for the marathon-sessions share elsewhere in Chronicle, reported here as this session\'s actual hours rather than a 0%/100% flag.',
    });
  }

  if (ctx != null) {
    const pctWin = win ? Math.round((ctx / win) * 100) : 0;
    facts.push({
      key: 'peakContextTokens', format: 'tokens', value: ctx, value2: pctWin, exact: true, warn: pctWin >= 70,
      label: 'peak context tokens reached',
      why: "Chronicle's own heuristic threshold for rising cost is 70% of the model's context window — not a documented Claude Code auto-compact trigger.",
      info: "This session's largest stored context size, and what share that is of its model's context window. 70% is a heuristic threshold Chronicle chose to flag rising cost, not a documented auto-compact point.",
    });
  }

  const cacheDenom = cacheRead + cacheInput;
  facts.push({
    key: 'cacheEfficiency', format: 'percent', value: cacheDenom ? Math.round((cacheRead / cacheDenom) * 100) : 0, exact: true,
    label: 'of input tokens were served from cache',
    why: 'Higher is cheaper — a cache read costs a fraction of a fresh input token.',
    info: "The share of input-side tokens (fresh input plus cache reads) that came from cache reads, computed directly from each session's billed usage.",
  });

  facts.push({
    key: 'subagentTurns', format: 'percent', value: share(sub.tokens), count: sub.turns, exact: true,
    label: 'of usage came from subagent turns',
    why: "Work delegated to Task-launched subagents rather than answered on the main thread — each subagent pays its own context, worth it for parallel work but worth watching on simple tasks.",
    info: "Counts every reply a subagent produced, exact from Chronicle's per-message sidechain token columns — includes both workflow and standalone subagent runs.",
    countOne: 'subagent turn', countMany: 'subagent turns',
  });

  facts.push({
    key: 'workflowRuns', format: 'percent', value: share(wf.tokens), count: wf.runs, exact: true,
    label: 'of usage ran inside a multi-agent workflow',
    why: 'Tokens spent on groups of subagents launched together to divide one task.',
    info: "A workflow run is a group of subagents nested under one shared workflow folder — this is their exact share of billed tokens, not a text-length estimate.",
    countOne: 'workflow run', countMany: 'workflow runs',
  });

  if (active != null && engaged != null) {
    const ratio = active > 0 ? Math.round((engaged / active) * 100) : 0;
    facts.push({
      key: 'unattendedRatio', format: 'percent', value: ratio, exact: true, warn: ratio < 25,
      label: "engaged time as a share of agent-active time",
      why: 'Lower means you were around for less of the time the agent was working — engaged (wall-clock) time under a quarter of active time means the session ran mostly unattended.',
      info: "Engaged is your wall-clock presence; agent-active is the agent's working time. This is engaged ÷ active for this session, capped the same way both durations are capped at import.",
    });
  }

  return facts;
}
