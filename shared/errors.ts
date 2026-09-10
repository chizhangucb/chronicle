// shared/errors.ts
// The ONE tool_result error heuristic, on both sides of the wire. The server
// stores `sessions.error_count` with it at import and Explore attributes
// errors per tool with it; the client counts errors on a LIVE session, which
// has no stored row yet (src/session/stats.ts). It lives here so those two
// answers cannot disagree — it used to be a server copy plus a hand-written
// client twin kept in step by a gotcha entry.
//
// Relative-import value module (never @shared), same B3 rule as
// shared/pricing.ts and shared/provider.ts.

export const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;

// Only the head of a tool result is tested. The SQL side of the same rule
// reads substr(text, 1, 200), so JS and SQL must cut at the same character or
// a long result would count as an error on one side only. The heuristic is
// anchored at the head anyway.
export const ERROR_HEAD_CHARS = 200;

export function isErrorHead(text: string | null | undefined): boolean {
  return ERROR_RE.test((text || '').slice(0, ERROR_HEAD_CHARS));
}
