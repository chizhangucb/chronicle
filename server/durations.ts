// Shared duration metrics, computed at import time and stored on `sessions`
// (design doc §1.3). The UI and contract views read the stored numbers; the
// client-side fallback in SessionView mirrors these rules for live sessions.

// Not every role=user message is a human prompt: task notifications, system
// reminders, command wrappers and interrupts all log with role=user. Their
// preceding gap counts as ACTIVE (the agent/app was busy) — only a genuinely
// typed prompt subtracts time. Mirrors SYNTHETIC_USER_RE in src/SessionView.jsx.
export const SYNTHETIC_USER_RE = /^\s*(?:<task-notification|<launch-selected-element|<system-reminder|<command-name|<command-message|<local-command|\[Request interrupted)/;

export function isHumanPrompt(e) {
  return e.kind === 'user' && !SYNTHETIC_USER_RE.test(e.text || '');
}

const ACTIVE_GAP_CAP_MS = 10 * 60 * 1000;   // generic gaps: 10-min cap
const ENGAGED_GAP_CAP_MS = 90 * 60 * 1000;  // engaged time: 90-min cap

// Canonical "Agent Active" (8/6-amended): per-timeline scan over ALL rows
// (sidechains included) sorted by ts. Gap rules:
//  1. gap into a genuine human prompt → excluded entirely;
//  2. gap ending in a tool_result matched to a prior tool_use → counted in
//     FULL (real tool/build time, no cap);
//  3. everything else → counted, capped at 10 min.
export function agentActiveMs(events) {
  const rows = withTimes(events);
  const seenToolUse = new Set();
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
export function engagedMs(events) {
  const rows = withTimes(events);
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].t - rows[i - 1].t;
    if (gap > 0) sum += Math.min(gap, ENGAGED_GAP_CAP_MS);
  }
  return sum;
}

function withTimes(events) {
  return events
    .map((e) => ({ e, t: e.ts ? new Date(e.ts).getTime() : NaN }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}
