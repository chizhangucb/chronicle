// The ONE server-side copy of the tool_result error heuristic. Historically
// duplicated across routes/projects.ts + insights.ts + explore.ts (with the
// documented "change all copies together" gotcha); they now all import this.
// src/SessionView.tsx's isErrorResult is the client twin — keep it in sync.
export const ERROR_RE = /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i;

// Matches the SQL-side convention of testing only the first 200 chars
// (substr(text, 1, 200)) — the heuristic is anchored at the head anyway.
export function isErrorHead(text: string): boolean {
  return ERROR_RE.test(text.slice(0, 200));
}
