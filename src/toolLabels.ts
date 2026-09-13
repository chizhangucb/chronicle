// Friendly tool labels: the single source of truth for how a raw tool name is
// displayed. The session Overview (src/session/OverviewMode.tsx) reads it for
// its tool-mix bars and its call timeline, the project Overview's aggregator
// (src/analytics/projectAggregates.ts) for its call ranking, so the same tool
// can never be named two different ways on two surfaces.
//
// A raw name with no entry here has no friendly spelling and keeps its own
// name. What a surface then does with it is the surface's own business (the
// project ranking buckets an over-long one as "Other"), because that fallback
// is a property of what the surface has room to render, not of the label map.
const TOOL_LABEL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};

// The label for one raw tool name, the one spelling of the lookup: the map
// itself is not exported, so there is no second way to read it. A missing or
// empty name is the empty string, so a caller rendering a row for an unnamed
// call can fall back with `||`. The lookup is own-key only: a tool literally
// named `constructor` or `toString` would otherwise read a function off
// Object.prototype and hand the caller a non-string to render.
export function friendlyToolLabel(name: string | null | undefined): string {
  const raw = name ?? '';
  return Object.hasOwn(TOOL_LABEL, raw) ? TOOL_LABEL[raw] : raw;
}
