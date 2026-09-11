// The row shapes Chronicle's routes return, declared once (#307, audit F10).
//
// A "row" here is one record as it leaves the server: the persisted `sessions`
// and `messages` columns, the per-surface session summaries the engines
// project, and the count rows the aggregates return. The server used to
// declare each of these next to the query that produced it and the client
// retyped it by hand in `src/api.ts` (and again in `SessionView.tsx`), so a
// column added on one side was invisible on the other. Both sides import from
// here now.
//
// Framework-free, like the rest of `shared/`: no db handle, no express, no
// React, relative imports only.
import type { Kind, Project } from './types.ts';

// Full `sessions` row, as read back out of the DB (every column, including the
// ones added by schema.ts's idempotent ALTER TABLE migrations).
export interface SessionRow {
  id: string;
  project_id: number;
  // The DB column is untyped TEXT, so this stays wider than `SourceId`.
  source: string;
  file_path: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  context_tokens: number | null;
  name: string | null;
  summary: string | null;
  usage: string | null;
  sidechain_count: number;
  imported_at: string | null;
  agent_active_ms: number | null;
  engaged_ms: number | null;
  minor: number;
  result_count: number | null;
  error_count: number | null;
  // Provenance of `usage`. 'exact' = parsed from a transcript by a
  // parser that collapses repeated usage lines on (message_id, request_id).
  // 'rederived' = the source transcript is gone, so the migration
  // rebuilt it structurally from the stored per-message token columns.
  // 'unverified' = neither was possible; the pre-fix (inflated) value stands.
  // NULL = imported before the column existed.
  usage_source: string | null;
}

// Full `messages` row. `Event` (shared/types.ts) is the pre-insert shape a
// parser produces; this is the persisted, read-back one — id/session_id/seq are
// always present and `kind` is always set.
export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  uuid: string | null;
  ts: string | null;
  // One of the five closed kinds: a parser only ever emits those, and the
  // column is written from a parsed `Event` (shared/types.ts).
  kind: Kind;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  model: string | null;
  // The DB stores 0/1, the same spelling `Event` (shared/types.ts) uses.
  is_sidechain: 0 | 1;
  agent_type: string | null;
  workflow_id: string | null;
  agent_id: string | null;
  agent_desc: string | null;
  skill: string | null;
  // Anthropic's per-API-call identity. `uuid` above is per transcript LINE;
  // one API call is split across several lines, so this pair is the only
  // stable per-CALL key.
  message_id: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_w5m_tokens: number | null;
  cache_w1h_tokens: number | null;
}

// A `projects` row. Same shape as the shared entity; named for the table so
// server queries can say what they select.
export type ProjectRow = Project;

// Git repo facts for a project, embedded on the project list, the project page
// and the session payload (server/git.ts `repoInfo()`).
export interface RepoInfo {
  isRepo: boolean;
  commitCount?: number;
  branch?: string | null;
}

// One commit on a project's history (server/git.ts). `beforeHistory` marks the
// synthetic "older than the first commit Chronicle can see" marker.
export interface Commit {
  hash: string;
  date: string;
  subject: string;
  beforeHistory?: boolean;
}

// A session row on the project page (GET /api/projects/:id): the stored
// columns the page reads, plus the two live flags computed server-side, with
// `file_path` stripped before it reaches the client.
export interface ProjectSessionSummary {
  id: string;
  // Untyped TEXT in the DB, like `SessionRow.source`.
  source: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  name: string | null;
  summary: string | null;
  context_tokens: number | null;
  /** JSON-stringified `UsageByModel` — read it with shared/usage.ts parseUsage. */
  usage: string | null;
  agent_active_ms: number | null;
  char_count: number | null;
  liveCandidate: boolean;
  ongoing: boolean;
}

// A session row on Insights (GET /api/insights), carrying its project's name
// so the cross-project lists need no second lookup.
export interface InsightsSessionRow {
  id: string;
  project_id: number;
  project_name: string;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  agent_active_ms: number | null;
  engaged_ms: number | null;
  context_tokens: number | null;
  usage: string | null;
}

// A session the noise gate marked minor (GET /api/sessions/minor).
export interface MinorSessionRow {
  id: string;
  project_id: number;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  message_count: number;
  agent_active_ms: number | null;
  started_at: string | null;
  project_name: string;
}

// One hit from GET /api/search.
export interface SearchResultItem {
  id: string;
  project_id: number;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  project_name: string;
  matchCount: number;
  snippet: string;
  seq?: number;
  ts: string | null;
  // Only populated on the empty-query "recent" branch (server/routes/search.ts);
  // the FTS/LIKE match branch does not select them. The Home ledger's
  // Cost/Active/Msgs columns read them.
  message_count?: number;
  usage?: string | null;
  agent_active_ms?: number | null;
}

/** A custom redaction or allow rule (the `security_rules` row). `enabled` is
 * the stored INTEGER 0/1, and `builtin_override` names the built-in rule this
 * one supersedes, when it does. */
export interface SecurityRuleRow {
  id: number;
  name: string;
  pattern: string;
  replacement: string;
  kind: 'redact' | 'allow';
  enabled: number;
  builtin_override: string | null;
}

// ---- Aggregate count rows ----

/** Calls per tool name, over a scope and range. The query counts `tool_use`
 * rows with a tool name, so the name is always there. */
export interface ToolCount { name: string; count: number }
/** Messages per kind. */
export interface KindCount { kind: string; count: number }
/** Messages per LOCAL calendar day (`YYYY-MM-DD`). */
export interface DayCount { day: string; count: number }
/** Error heads and tool-result heads per project, for the errors rollup. */
export interface ProjectErrorCount { project_id: number; head_count: number; error_count: number }
