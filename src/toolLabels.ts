// The one friendly tool-label map (#374).
//
// Raw tool names are the source tool's own vocabulary (`Bash`, `WebFetch`);
// every surface that ranks tool calls renames them for the operator. That map
// used to exist twice — once in src/session/stats.ts for the session Overview
// and once in src/ProjectDetail.tsx for the project Overview — so the same
// tool could be named two different ways on two surfaces. It is declared here
// once and both callers import it.
//
// A tool with no entry keeps its own name: the map renames the common ones,
// it does not gate which tools may be shown.
const FRIENDLY_CALL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};

// The label for one raw tool name. A missing/empty name is the empty string,
// so a caller rendering a row for an unnamed call can fall back with `||`.
// The lookup is own-key only: a tool literally named `constructor` or
// `toString` would otherwise read a function off Object.prototype and hand the
// caller a non-string to render.
export function friendlyToolLabel(name: string | null | undefined): string {
  const raw = name ?? '';
  return Object.hasOwn(FRIENDLY_CALL, raw) ? FRIENDLY_CALL[raw] : raw;
}
