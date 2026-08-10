// Session Overview stats helpers (see src/session/OverviewMode.tsx).
//
// These functions run over BOTH server-persisted rows (src/api.ts `Message`,
// `kind: string`) and freshly parsed/live events (@shared `Event`, `kind: Kind`
// — a narrower union). A shared `Event`-typed parameter would reject the wider
// `Message.kind: string` at call sites, so this local `StatMessage` mirrors
// @shared's `Event` fields but keeps `kind` as `string` (a `Kind` value is
// still assignable to it, since `Kind` is a subtype of `string`) — the honest
// common shape both callers satisfy.
export interface StatMessage {
  kind: string;
  ts?: string | null;
  text?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_use_id?: string | null;
  model?: string | null;
  seq?: number;
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
const DONUT_COLORS = ['#4f8ef7', '#34c98e', '#e5a54b', '#a78bfa', '#f472b6', '#38bdf8', '#e5684b', '#8b98a9'];
const DELETABLE_SOURCES = new Set(['claude-code', 'codex']);

function isErrorResult(m: StatMessage): boolean {
  return m.kind === 'tool_result'
    && /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i
      .test((m.text || '').slice(0, 200));
}

// Count occurrences → top-7 [name, count] entries plus an aggregated "other".
function topDist(names: string[]): [string, number][] {
  const d = new Map<string, number>();
  for (const n of names) d.set(n, (d.get(n) || 0) + 1);
  const sorted = [...d.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 7);
  const other = sorted.slice(7).reduce((s, [, n]) => s + n, 0);
  if (other) top.push(['other', other]);
  return top;
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
  DONUT_COLORS,
  DELETABLE_SOURCES,
  isErrorResult,
  topDist,
  fmtCtx,
  fmtTokNum,
  fmtDur,
  SYNTHETIC_USER_RE,
  isHumanPrompt,
  activeDurationMs,
  engagedDurationMs,
};
