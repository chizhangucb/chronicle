// Shared duration metrics, computed at import time and stored on `sessions`
// (design doc §1.3). The UI and contract views read the stored numbers; the
// client-side fallback in SessionView mirrors these rules for live sessions.

import type { Event } from '../shared/types.ts';
import { SYNTHETIC_USER_RE, isSyntheticUserText } from '../shared/synthetic.ts';

// SYNTHETIC_USER_RE now lives in shared/synthetic.ts (one definition shared with
// the client session stats + the parsers' first-prompt derivation). CHI-368
// folded cross-session (agent-to-agent IPC) messages into it: a gap INTO one is
// no longer subtracted as human-think time — an injected IPC message isn't a
// human typing — so it counts as active (capped) like any other synthetic turn.
export { SYNTHETIC_USER_RE };

export function isHumanPrompt(e: Event): boolean {
  return e.kind === 'user' && !isSyntheticUserText(e.text);
}

const ACTIVE_GAP_CAP_MS = 10 * 60 * 1000;   // generic gaps: 10-min cap
const ENGAGED_GAP_CAP_MS = 90 * 60 * 1000;  // engaged time: 90-min cap

// Canonical "Agent Active" (8/6-amended): per-timeline scan over ALL rows
// (sidechains included) sorted by ts. Gap rules:
//  1. gap into a genuine human prompt → excluded entirely;
//  2. gap ending in a tool_result matched to a prior tool_use → counted in
//     FULL (real tool/build time, no cap);
//  3. everything else → counted, capped at 10 min.
export function agentActiveMs(events: Event[]): number {
  const rows = withTimes(events);
  const seenToolUse = new Set<string>();
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (i > 0) {
      const gap = cur.t - rows[i - 1].t;
      if (gap > 0 && !isHumanPrompt(cur.e)) {
        const matchedResult = cur.e.kind === 'tool_result'
          && cur.e.tool_use_id && seenToolUse.has(cur.e.tool_use_id);
        sum += matchedResult ? gap : Math.min(gap, ACTIVE_GAP_CAP_MS);
      }
    }
    if (cur.e.kind === 'tool_use' && cur.e.tool_use_id) seenToolUse.add(cur.e.tool_use_id);
  }
  return sum;
}

// "Engaged time": sum of ALL inter-message gaps, each capped at 90 min.
// No human/synthetic distinction — approximates hands-on wall-clock time.
export function engagedMs(events: Event[]): number {
  const rows = withTimes(events);
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].t - rows[i - 1].t;
    if (gap > 0) sum += Math.min(gap, ENGAGED_GAP_CAP_MS);
  }
  return sum;
}

interface TimedEvent {
  e: Event;
  t: number;
}

function withTimes(events: Event[]): TimedEvent[] {
  return events
    .map((e): TimedEvent => ({ e, t: e.ts ? new Date(e.ts).getTime() : NaN }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}
