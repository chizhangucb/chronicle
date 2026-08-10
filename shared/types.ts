// Chronicle shared type contract — the normalized event model that every parser,
// the DB layer, and the client agree on. Framework-free by design (no React /
// express imports): it is imported by the server via a relative path
// (`../shared/types.ts`) and by the client via the `@shared` alias
// (vite.config.js resolve.alias + tsconfig paths).
//
// These names/optionality are cross-checked against the REAL code:
//   server/parsers/claudeCode.js + codex.js (event + usage shapes),
//   server/db.js (message/session columns, replaceSession),
//   src/kinds.js (label/icon maps).
// Change them only alongside those files.

// ─────────────────────────────────────────────────────────────────────────────
// Kinds

// The canonical normalized message kinds. Every parser emits exactly these, and
// `messages.kind` in the DB only ever holds one of them.
export type Kind = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';

// 'note' ('Inserted' in the UI) is a CLIENT-ONLY display kind: user-inserted
// Refine notes exist only in client state and are never produced by a parser or
// written to `messages`. So it is deliberately EXCLUDED from the canonical `Kind`
// union and modeled separately here. src/kinds.js keys its label/icon maps by
// DisplayKind; anything that reads/writes the event model uses `Kind`.
export type DisplayKind = Kind | 'note';

// Import sources (one parser each). See server/parsers/*.
export type SourceId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'gemini'
  | 'copilot';

// ─────────────────────────────────────────────────────────────────────────────
// Events (normalized message rows)

// A normalized event as produced by the parsers, consumed by server/durations.js
// and server/db.js (replaceSession), and carried in live SSE / client state.
// Optionality mirrors the parsers: only `kind` is always present; the DB coerces
// every missing field to NULL on insert. `tool_input` is a JSON string (already
// stringified by the parser), NOT a parsed object.
export interface Event {
  kind: Kind;
  ts?: string | null;
  uuid?: string | null;
  text?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_use_id?: string | null;
  model?: string | null;
  // Assigned per-row at insert time (message index) and present on live SSE rows;
  // absent on freshly parsed events.
  seq?: number;
  // Parsers set this to 1 for sidechain rows; the DB stores 0/1.
  is_sidechain?: 0 | 1;
  agent_type?: string | null;
  skill?: string | null;
  // Per-message token usage (one API call's numbers on the first event of the line).
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_w5m_tokens?: number | null;
  cache_w1h_tokens?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage (per-model token aggregation)

// Per-model token totals aggregated by the parser. 5-minute and 1-hour cache
// writes are billed at different rates, so they stay split (see claudeCode.js
// usageByModel and src/models.js).
export interface ModelUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

// The `sessions.usage` map, keyed by model id. Stored on the session as a JSON
// string (JSON.stringify of this object).
export type Usage = Record<string, ModelUsage>;

// ─────────────────────────────────────────────────────────────────────────────
// Sessions & projects

// A logical project (db `projects` row), keyed on the physical cwd from logs.
export interface Project {
  id: number;
  path: string;
  name: string;
  created_at?: string;
}

// What a parser's parse<Tool>Session() returns on its `session` field: keyed on
// `cwd` (used to resolve/insert the project), NOT yet a `project_id`.
export interface ParsedSession {
  id: string;
  source: SourceId;
  file_path: string;
  cwd: string | null;
  started_at: string | null;
  ended_at: string | null;
  first_prompt: string | null;
  summary?: string | null;
  context_tokens?: number | null;
  // JSON-stringified `Usage`, or null when a source records no token usage.
  usage?: string | null;
  skipped?: number;
}

// What server/db.js `replaceSession(session, events)` consumes: the resolved row,
// with `project_id` in place of `cwd`. `name` is a user-set override preserved
// across re-import; the rest are re-derived each import.
export interface SessionInput {
  id: string;
  project_id: number;
  source: SourceId;
  file_path: string;
  started_at?: string | null;
  ended_at?: string | null;
  first_prompt?: string | null;
  context_tokens?: number | null;
  name?: string | null;
  summary?: string | null;
  usage?: string | null;
}

// The `{ session, events }` pair every parser returns.
export interface ParseResult {
  session: ParsedSession;
  events: Event[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan shapes (importable-project discovery, scan<Tool>Projects())

// One session listed by a scan (pre-import). Field availability varies by source
// (e.g. Codex has no summary label), hence the optionals.
export interface ScannedSession {
  id: string;
  // Per-file sources (Claude Code, Codex) always set this; DB-backed sources
  // (OpenCode) have no per-session file, so it's null there.
  file: string | null;
  label?: string | null;
  modifiedAt?: string | null;
  messageEstimate?: number;
}

// One importable project group returned by scan<Tool>Projects().
export interface ScannedProject {
  source: SourceId;
  logDir: string;
  name: string;
  physicalPath: string | null;
  sessionCount: number;
  messageEstimate: number;
  // Cursor's scan only returns aggregate counts per workspace, not a per-session
  // list (the client guards with `Array.isArray(item.sessions)`), so this is
  // optional — every other source's scanner sets it.
  sessions?: ScannedSession[];
  // Codex groups by cwd across many files.
  files?: string[];
  // OpenCode groups by directory (== physicalPath here); autosync/live re-parse
  // by directory directly rather than re-deriving it from physicalPath.
  directory?: string;
}
