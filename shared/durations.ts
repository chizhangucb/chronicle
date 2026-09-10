// shared/durations.ts
// The ONE agent-active / engaged-time computation, on both sides of the wire.
// The server computes both at import and stores them on `sessions`; the client
// computes them over a LIVE session's messages, which has no stored row yet
// (src/session/OverviewMode.tsx). It lives here so those two answers cannot
// disagree — it used to be a server copy plus a hand-written client twin kept
// in step by a gotcha entry.
//
// Relative-import value module (never @shared), same B3 rule as
// shared/pricing.ts and shared/errors.ts.

// "Not a human turn" is shared/synthetic.ts's one definition, the same one the
// parsers derive a first prompt with. It folds cross-session (agent-to-agent
// IPC) messages in: a gap INTO one is not subtracted as human-think time — an
// injected IPC message isn't a human typing — so it counts as active (capped)
// like any other synthetic turn.
import { isSyntheticUserText } from './synthetic.ts';

// The common shape both callers satisfy: a parsed `Event` (kind: Kind, a
// subtype of string) and a stored message row (src/api.ts `Message`, whose
// `kind` is the wider `string`) are both assignable to it. Typing the
// parameter as `Event` would reject the stored row at the client's call
// sites, which is what forced the client twin in the first place.
export interface TimedMessage {
  kind: string;
  ts?: string | null;
  text?: string | null;
  tool_use_id?: string | null;
}

export function isHumanPrompt(m: TimedMessage): boolean {
  return m.kind === 'user' && !isSyntheticUserText(m.text);
}

// Generic gaps (anything that is not a matched tool_result) count at most this.
export const ACTIVE_GAP_CAP_MS = 10 * 60 * 1000;
// Engaged time counts every gap, each at most this.
export const ENGAGED_GAP_CAP_MS = 90 * 60 * 1000;

// Canonical "Agent Active" (8/6-amended): per-timeline scan over ALL rows
// (sidechains included) sorted by ts. Gap rules:
//  1. gap into a genuine human prompt → excluded entirely;
//  2. gap ending in a tool_result matched to a prior tool_use → counted in
//     FULL (real tool/build time, no cap);
//  3. everything else → counted, capped at ACTIVE_GAP_CAP_MS.
export function agentActiveMs(messages: TimedMessage[]): number {
  const rows = withTimes(messages);
  const seenToolUse = new Set<string>();
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (i > 0) {
      const gap = cur.t - rows[i - 1].t;
      if (gap > 0 && !isHumanPrompt(cur.m)) {
        const matchedResult = cur.m.kind === 'tool_result'
          && !!cur.m.tool_use_id && seenToolUse.has(cur.m.tool_use_id);
        sum += matchedResult ? gap : Math.min(gap, ACTIVE_GAP_CAP_MS);
      }
    }
    if (cur.m.kind === 'tool_use' && cur.m.tool_use_id) seenToolUse.add(cur.m.tool_use_id);
  }
  return sum;
}

// "Engaged time": sum of ALL inter-message gaps, each capped at
// ENGAGED_GAP_CAP_MS. No human/synthetic distinction — approximates hands-on
// wall-clock time.
export function engagedMs(messages: TimedMessage[]): number {
  const rows = withTimes(messages);
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].t - rows[i - 1].t;
    if (gap > 0) sum += Math.min(gap, ENGAGED_GAP_CAP_MS);
  }
  return sum;
}

interface TimedRow {
  m: TimedMessage;
  t: number;
}

function withTimes(messages: TimedMessage[]): TimedRow[] {
  return messages
    .map((m): TimedRow => ({ m, t: m.ts ? new Date(m.ts).getTime() : NaN }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}
