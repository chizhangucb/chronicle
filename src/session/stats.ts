// Session Overview stats helpers (see src/session/OverviewMode.tsx).
//
// These functions run over BOTH server-persisted rows (src/api.ts `Message`,
// `kind: string`) and freshly parsed/live events (@shared `Event`, `kind: Kind`
// — a narrower union). A shared `Event`-typed parameter would reject the wider
// `Message.kind: string` at call sites, so this local `StatMessage` mirrors
// @shared's `Event` fields but keeps `kind` as `string` (a `Kind` value is
// still assignable to it, since `Kind` is a subtype of `string`) — the honest
// common shape both callers satisfy.
// stats.ts is executed directly by node (unit tests import it as `.ts`, and
// node's strip-only loader takes import specifiers literally — it does NOT
// rewrite `.js` → `.ts` the way Vite's bundler resolution does). So unlike the
// `.tsx` call sites in this file's siblings (OverviewMode.tsx, ProjectDetail.tsx,
// which only ever run through Vite/tsc and use `../models.js`), this import
// must point at the real `.ts` file.
import { costOf, type ModelUsageInput } from '../models.ts';
export interface StatMessage {
  kind: string;
  ts?: string | null;
  text?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_use_id?: string | null;
  model?: string | null;
  seq?: number;
  // Sidechain (subagent) rows — see subagentRuns()/subagentRunCount() below.
  is_sidechain?: 0 | 1;
  agent_type?: string | null;
  agent_id?: string | null;
  agent_desc?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

function summarizeToolInput(name: string | null | undefined, inputJson: string | null | undefined): string {
  try {
    const input: Record<string, unknown> = JSON.parse(inputJson || '{}');
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.command === 'string') return input.command;
    if (typeof input.pattern === 'string') return input.pattern;
    if (typeof input.query === 'string') return input.query;
    const s = JSON.stringify(input);
    return s === '{}' ? '' : s;
  } catch { return inputJson || ''; }
}

// ---- Overview mode: per-session stats dashboard (the session "home page") ----

const FRIENDLY_CALL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};
const DELETABLE_SOURCES = new Set(['claude-code', 'codex']);

function isErrorResult(m: StatMessage): boolean {
  return m.kind === 'tool_result'
    && /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i
      .test((m.text || '').slice(0, 200));
}

// Errors KPI drill-in (src/session/OverviewMode.tsx's Errors card →
// src/SessionView.tsx's Playback filter): the erroring tool_result rows PLUS
// their paired tool_use call, matched by `tool_use_id` — the same pairing
// rule server/errors.ts documents for aggregate error attribution, applied
// here to pick out individual rows instead of counting them. Mirrors
// `messages.filter(isErrorResult)` (the count shown on the KPI itself), so
// the drill-in view shows exactly what was counted, plus the call that
// produced each error. Generic over `T` so it can run over the client's
// richer `PlaybackMessage` (SessionView.tsx) without losing those fields.
function errorDrillIn<T extends StatMessage>(messages: T[]): T[] {
  const erroringIds = new Set<string>();
  for (const m of messages) {
    if (isErrorResult(m) && m.tool_use_id) erroringIds.add(m.tool_use_id);
  }
  return messages.filter((m) => isErrorResult(m)
    || (m.kind === 'tool_use' && !!m.tool_use_id && erroringIds.has(m.tool_use_id)));
}

// Tool-mix counts, reshaped for Recharts' `data` prop — every tool, sorted
// desc by count (unlike a top-7 + "other" cut, the Tool Mix card only ever
// renders its own top slice, so no aggregation bucket is needed here).
function toolMixSorted(messages: StatMessage[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.kind !== 'tool_use' || !m.tool_name) continue;
    counts.set(m.tool_name, (counts.get(m.tool_name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

// A per-assistant-turn cumulative-cost point series for the "Cost over
// session" chart. Chronicle only stores AGGREGATE per-model usage on the
// session (no per-turn token breakdown), so this distributes the known
// per-model total evenly across that model's assistant turns in chronological
// order — an approximation (real spend is lumpier), good enough for the
// trend shape the chart is showing. `usageByModel` is the parsed
// `session.usage` JSON (Record<model, ModelUsageInput>).
function cumulativeCostSeries(
  messages: StatMessage[],
  usageByModel: Record<string, ModelUsageInput>,
): { t: string; cumCost: number }[] {
  const turnsByModel = new Map<string, StatMessage[]>();
  for (const m of messages) {
    if (m.kind !== 'assistant' || !m.model || !m.ts) continue;
    if (!turnsByModel.has(m.model)) turnsByModel.set(m.model, []);
    turnsByModel.get(m.model)!.push(m);
  }
  const points: { t: string; cost: number }[] = [];
  for (const [model, turns] of turnsByModel) {
    const usage = usageByModel[model];
    const total = usage ? (costOf(model, usage) ?? 0) : 0;
    const perTurn = turns.length ? total / turns.length : 0;
    for (const turn of turns) points.push({ t: turn.ts as string, cost: perTurn });
  }
  points.sort((a, b) => a.t.localeCompare(b.t));
  let running = 0;
  return points.map((p) => { running += p.cost; return { t: p.t, cumCost: running }; });
}

function fmtCtx(tokens: number): string {
  if (tokens >= 1e6) return `${tokens % 1e6 === 0 ? tokens / 1e6 : (tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

// Token count with one decimal (matches Claude Code's /usage: 13.6k, 1.1m, 512.1k).
function fmtTokNum(n: number | null | undefined): string {
  n = n || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Human duration: "45m" under an hour, "2h 5m" above, "—" for null/zero.
function fmtDur(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

// Not every `user`-role message is a human prompt. Background-task completions
// (`<task-notification>`), UI element selections (`<launch-selected-element>`),
// interrupt markers, and other harness/system injections all carry role=user in
// the logs. The pause before one of these is NOT the human thinking — the agent
// was busy (e.g. a background build) or you were interacting with the app — so it
// must not be subtracted from active time. Only a genuine typed prompt counts as
// "human turn". This regex matches the injected forms; a real prompt rarely opens
// with one of these tags.
const SYNTHETIC_USER_RE = /^\s*(?:<task-notification|<launch-selected-element|<system-reminder|<command-name|<command-message|<local-command|\[Request interrupted)/;
function isHumanPrompt(m: StatMessage): boolean {
  return m.kind === 'user' && !SYNTHETIC_USER_RE.test(m.text || '');
}

// Client-side fallback for sessions imported before v0.2 (which stored
// agent_active_ms / engaged_ms at import — server/durations.js is the canonical
// implementation; keep the rules in sync). Agent Active: exclude gaps into a
// genuine human prompt; count tool_result gaps (matched to a prior tool_use) in
// FULL; cap every other gap at 10 minutes. Engaged: every gap, 90-minute cap.
function activeDurationMs(messages: StatMessage[]): number {
  const seq = messages
    .filter((m) => m.ts)
    .map((m) => ({ m, t: new Date(m.ts as string).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
  const seenToolUse = new Set<string>();
  let sum = 0;
  for (let i = 0; i < seq.length; i++) {
    const { m } = seq[i];
    if (i > 0) {
      const g = seq[i].t - seq[i - 1].t;
      if (g > 0 && !isHumanPrompt(m)) {
        const matchedResult = m.kind === 'tool_result' && !!m.tool_use_id && seenToolUse.has(m.tool_use_id);
        sum += matchedResult ? g : Math.min(g, 10 * 60 * 1000);
      }
    }
    if (m.kind === 'tool_use' && m.tool_use_id) seenToolUse.add(m.tool_use_id);
  }
  return sum;
}

export interface SubagentTypeGroup {
  agentType: string;
  // Distinct RUNS (agent_id) of this type — what the D3 drill-in row shows
  // ("<type> · N runs · tokens"), NOT the same number as `turns`. Falls back
  // to 1 when every row of this type predates the agent_id column (no run
  // identity to count), matching subagentRunCount()'s whole-session fallback.
  runCount: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

// Groups sidechain (subagent) rows by `agent_type` — the source for the
// Overview "Subagents" card (src/session/OverviewMode.tsx) and its type-level
// drill-in (src/SessionView.tsx run list). Callers pass the UNFILTERED
// message array (SessionView's default `messages` has sidechains stripped
// out). Sorted desc by total tokens (input+output) so the busiest subagent
// type leads. The parser stamps `agent_type`/`agent_id` on EVERY sidechain
// event (user/tool_use/tool_result/thinking/assistant), not just assistant
// turns — so `turns` (and tokens, which only assistant rows carry) must be
// gated to `kind === 'assistant'` or turns double/triple-counts each real
// turn via its accompanying tool_use/tool_result rows; `agent_id` collection
// for `runCount` does NOT need that gate (any kind carries it).
function subagentRuns(messages: StatMessage[]): SubagentTypeGroup[] {
  const map = new Map<string, { agentType: string; turns: number; inputTokens: number; outputTokens: number; agentIds: Set<string> }>();
  for (const m of messages) {
    if (!m.is_sidechain || !m.agent_type) continue;
    const cur = map.get(m.agent_type) ?? { agentType: m.agent_type, turns: 0, inputTokens: 0, outputTokens: 0, agentIds: new Set<string>() };
    if (m.agent_id) cur.agentIds.add(m.agent_id);
    if (m.kind === 'assistant') {
      cur.turns++;
      cur.inputTokens += m.input_tokens ?? 0;
      cur.outputTokens += m.output_tokens ?? 0;
    }
    map.set(m.agent_type, cur);
  }
  return [...map.values()]
    .map((g) => ({ agentType: g.agentType, runCount: g.agentIds.size || 1, turns: g.turns, inputTokens: g.inputTokens, outputTokens: g.outputTokens }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

export interface SubagentRunInfo {
  id: string;
  agentType: string;
  startTs: string | null;
  endTs: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  description: string | null;
}

// The RUN LIST for one subagent type (D3 two-level drill-in): one row per
// distinct `agent_id`, sorted by start time. `startTs`/`endTs` are the
// min/max ts seen across ALL of that run's rows (any kind), so a run with no
// assistant turn (rare, but possible for a very short-lived agent) still gets
// a start time. `turns`/tokens are assistant-gated for the same reason
// subagentRuns() gates them. `description` is the first non-null
// `agent_desc` seen for the run (the parser stamps it on every event of a
// file-based run, so any row has it if the sidecar had one).
function subagentRunList(messages: StatMessage[], agentType: string): SubagentRunInfo[] {
  const map = new Map<string, SubagentRunInfo>();
  for (const m of messages) {
    if (!m.is_sidechain || !m.agent_id || m.agent_type !== agentType) continue;
    let cur = map.get(m.agent_id);
    if (!cur) {
      cur = { id: m.agent_id, agentType, startTs: null, endTs: null, turns: 0, inputTokens: 0, outputTokens: 0, description: null };
      map.set(m.agent_id, cur);
    }
    if (m.ts) {
      if (!cur.startTs || m.ts < cur.startTs) cur.startTs = m.ts;
      if (!cur.endTs || m.ts > cur.endTs) cur.endTs = m.ts;
    }
    if (m.kind === 'assistant') {
      cur.turns++;
      cur.inputTokens += m.input_tokens ?? 0;
      cur.outputTokens += m.output_tokens ?? 0;
    }
    if (!cur.description && m.agent_desc) cur.description = m.agent_desc;
  }
  return [...map.values()].sort((a, b) => (a.startTs ?? '').localeCompare(b.startTs ?? ''));
}

// The Overview Subagents card HEADER count: distinct subagent RUNS, not
// distinct agent_type kinds (subagentRuns() above groups by kind — many runs
// of "workflow-subagent" collapse to one row there; that's still right for
// the detail rows, just wrong for "how many subagents ran"). Counts distinct
// non-null `agent_id` across every sidechain row (any kind — the parser
// stamps agent_id on every event of a run, not just assistant turns, so no
// kind gate is needed the way subagentRuns() needs one for `turns`).
// Falls back to the agent_type-group count when every sidechain row has a
// null agent_id — sessions imported before this column existed. Operates
// only on the passed-in `messages` (already deduped by uuid at import time),
// so a run is never double-counted between an inline sidechain entry and its
// file-based duplicate.
function subagentRunCount(messages: StatMessage[]): number {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.is_sidechain && m.agent_id) ids.add(m.agent_id);
  }
  return ids.size > 0 ? ids.size : subagentRuns(messages).length;
}

function engagedDurationMs(messages: StatMessage[]): number {
  const ts = messages.map((m) => (m.ts ? new Date(m.ts).getTime() : NaN))
    .filter(Number.isFinite).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g > 0) sum += Math.min(g, 90 * 60 * 1000);
  }
  return sum;
}

export {
  summarizeToolInput,
  FRIENDLY_CALL,
  DELETABLE_SOURCES,
  isErrorResult,
  errorDrillIn,
  toolMixSorted,
  cumulativeCostSeries,
  fmtCtx,
  fmtTokNum,
  fmtDur,
  SYNTHETIC_USER_RE,
  isHumanPrompt,
  activeDurationMs,
  engagedDurationMs,
  subagentRuns,
  subagentRunCount,
  subagentRunList,
};
