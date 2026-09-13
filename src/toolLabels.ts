// Friendly tool labels — the single source of truth for how a raw tool name
// is displayed. The session Overview (src/session/OverviewMode.tsx) reads it
// for its tool-mix bars and call timeline, the project Overview
// (src/ProjectDetail.tsx) for its call ranking, so the same tool can never be
// named two different ways on two surfaces (issue #375).
//
// A raw name with no entry here has no friendly spelling; each caller falls
// back on its own terms (the session Overview shows the raw name, the project
// ranking buckets an over-long one into "Other"), because the fallback is a
// property of what that surface has room to render, not of the label map.
export const FRIENDLY_CALL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};
