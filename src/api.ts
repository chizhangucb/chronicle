// Client fetch wrapper — every Chronicle REST endpoint in one place. Response
// shapes are declared locally where the server doesn't already export a type
// (see server/routes/*.ts); shared entities (Project, scan shapes) come from
// `@shared/types.ts`. `fetch`'s `res.json()` return is `unknown` at the type
// level — cast it once per call to the shape the route actually sends.
import type { Kind, Project, ScannedProject, ScannedSession, SourceId } from '@shared/types.ts';

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message = (body && typeof body === 'object' && 'error' in body) ? (body as { error?: string }).error : undefined;
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---- Scan / import (Import wizard) ----

export interface AnnotatedScannedSession extends ScannedSession {
  imported: boolean;
}

export interface AnnotatedScannedProject extends Omit<ScannedProject, 'sessions'> {
  imported: boolean;
  sessions?: AnnotatedScannedSession[];
}

export type ScanResult = Partial<Record<SourceId | string, AnnotatedScannedProject[]>>;

export interface ScanParams {
  source?: string;
  dir?: string;
}

// Matches server/routes/import-sync.ts GatherParsedParams — what the client
// sends to POST /api/import (a subset of a scanned item, or a hand-typed dir).
export interface ImportPayload {
  source: string;
  logDir?: string | null;
  files?: string[];
  directory?: string;
  sessionIds?: string[];
  physicalPath?: string | null;
}

export interface ImportProjectAgg {
  id: number;
  name: string;
  path: string;
  created: boolean;
  sessions: number;
  messages: number;
}

export interface ImportResult {
  ok: true;
  imported: number;
  skippedSessions: number;
  totalMessages: number;
  projects: ImportProjectAgg[];
  projectId: number | null;
}

// ---- Projects ----

export interface RepoInfo {
  isRepo: boolean;
  commitCount?: number;
  branch?: string | null;
}

export interface ProjectListItem extends Project {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
  git: RepoInfo;
}

export interface ProjectSessionSummary {
  id: string;
  source: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  name: string | null;
  summary: string | null;
  context_tokens: number | null;
  usage: string | null;
  agent_active_ms: number | null;
  char_count: number | null;
  liveCandidate: boolean;
  ongoing: boolean;
}

export interface NameCount {
  name: string | null;
  count: number;
}

export interface KindCount {
  kind: string;
  count: number;
}

export interface DayCount {
  day: string;
  count: number;
}

export interface ProjectDetail {
  project: Project;
  sessions: ProjectSessionSummary[];
  git: RepoInfo;
  analytics: {
    toolDist: NameCount[];
    kindDist: KindCount[];
    activity: DayCount[];
    errors: number;
    commits: number;
  };
}

export interface SyncResult {
  ok: true;
  imported: number;
  skippedSessions: number;
  totalMessages: number;
  sources: string[];
}

// ---- Sessions ----

// A normalized message row as stored/returned by the server — mirrors
// server/db.ts MessageRow. shared/types.ts `Event` is the pre-insert shape
// parsers produce; this is the persisted/read-back shape (id/session_id are
// always present, `kind` always set), so it stays a local type rather than
// reusing `Event` directly.
export interface Message {
  id: number;
  session_id: string;
  seq: number;
  uuid: string | null;
  ts: string | null;
  kind: Kind;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  model: string | null;
  is_sidechain: 0 | 1;
  agent_type: string | null;
  skill: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_w5m_tokens: number | null;
  cache_w1h_tokens: number | null;
}

// Mirrors server/db.ts SessionRow (full `sessions` row).
export interface Session {
  id: string;
  project_id: number;
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
}

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  beforeHistory?: boolean;
}

export interface SessionMessagesResult {
  session: Session;
  project: Project;
  messages: Message[];
  commits: Commit[];
  git: RepoInfo;
  liveCandidate: boolean;
}

export interface RenameSessionResult {
  id: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
}

export interface SessionSyncResult {
  ok: true;
  imported: number;
  totalMessages: number;
}

export interface DeleteSessionResult {
  ok: true;
  sourceDeleted: boolean;
  source: string;
  projectId: number;
}

// ---- Minor sessions bucket (noise gate) ----

export interface MinorSession {
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

export interface ResolveSessionResult {
  id: string;
  project_id: number;
}

// ---- Search ----

export interface SearchParams {
  q?: string;
  scope?: string;
  days?: string | number;
  project?: string | number;
}

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
  // Only populated on the empty-query "recent" branch of GET /api/search (see
  // server/routes/search.ts) — the FTS/LIKE match branch doesn't select them,
  // so they're undefined there. Used by the Home ledger's Cost/Active/Msgs columns.
  message_count?: number;
  usage?: string | null;
  agent_active_ms?: number | null;
}

export interface SearchResponse {
  recent: boolean;
  results: SearchResultItem[];
}

// ---- Settings ----

export interface Settings {
  autoSync: boolean;
  autoSyncPaused: boolean;
  launchAtLogin: boolean;
  minorActiveMsThreshold: number;
  minorMessageCountThreshold: number;
}

export type SettingsPatch = Partial<Settings>;

// ---- Autosync status (Settings section, near Settings) ----

export interface AutosyncStatus {
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  lastResult: { ok: true; imported: number; checked: number; ms: number } | { ok: true; skipped: string } | { ok: false; error: string } | null;
}

// ---- Insights (global cross-project hub, Task 5d-4) ----

// Mirrors server/insights.ts InsightsSessionRow/InsightsResult.
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

export interface InsightsResult {
  sessions: InsightsSessionRow[];
  toolDist: NameCount[];
  kindDist: KindCount[];
  modelDist: { model: string; count: number }[];
  // Fixed 30-day-trailing model distribution (mirrors server/insights.ts) —
  // Working Rhythm's "Favorite model" reads this, not `modelDist`, so it
  // stays in step with its fixed-window card-mates.
  modelDistFixed: { model: string; count: number }[];
  errors: number;
  errorsByProject: { project_id: number; head_count: number; error_count: number }[];
  commits: number;
  dailyActivity: DayCount[];
  hourlyActivity: { dow: number; hour: number; count: number }[];
  projects: { id: number; name: string }[];
}

// ---- Git ----

export type GitAtResult = { commit: Commit | null } | { noRepo: true };
export type GitTreeResult = { files: string[]; changed: string[] } | { noRepo: true };
export type GitFileResult =
  | { content: string | null; previous: string | null; prevCommit: string | null; changedInCommit: boolean }
  | { noRepo: true };

export const api = {
  scan: (params?: ScanParams): Promise<ScanResult> =>
    j('/api/scan' + (params ? `?${new URLSearchParams(params as Record<string, string>)}` : '')),
  import: (payload: ImportPayload): Promise<ImportResult> => j('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  projects: (): Promise<ProjectListItem[]> => j('/api/projects'),
  renameProject: (id: number | string, name: string): Promise<Project> => j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  deleteProject: (id: number | string): Promise<{ ok: true }> => j(`/api/projects/${id}`, { method: 'DELETE' }),
  syncProject: (id: number | string): Promise<SyncResult> => j(`/api/projects/${id}/sync`, { method: 'POST' }),
  project: (id: number | string, days?: number | string): Promise<ProjectDetail> =>
    j(`/api/projects/${id}${days ? `?days=${days}` : ''}`),
  search: (params: SearchParams): Promise<SearchResponse> =>
    j('/api/search?' + new URLSearchParams(params as Record<string, string>)),
  sessionMessages: (id: string): Promise<SessionMessagesResult> => j(`/api/sessions/${encodeURIComponent(id)}/messages`),
  renameSession: (id: string, name: string): Promise<RenameSessionResult> => j(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  syncSession: (id: string): Promise<SessionSyncResult> => j(`/api/sessions/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  deleteSessionSource: (id: string): Promise<{ ok: true }> =>
    j(`/api/sessions/${encodeURIComponent(id)}/source-file`, { method: 'DELETE' }),
  deleteSession: (id: string, withSource?: boolean): Promise<DeleteSessionResult> =>
    j(`/api/sessions/${encodeURIComponent(id)}${withSource ? '?source=1' : ''}`, { method: 'DELETE' }),
  undoDeleteSession: (source: string, id: string): Promise<{ ok: true }> => j('/api/sessions/undo-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, id }),
  }),
  minorSessions: (): Promise<MinorSession[]> => j('/api/sessions/minor'),
  promoteSession: (id: string): Promise<{ ok: true }> => j(`/api/sessions/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  settings: (): Promise<Settings> => j('/api/settings'),
  patchSettings: (patch: SettingsPatch): Promise<Settings> => j('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }),
  autosyncStatus: (): Promise<AutosyncStatus> => j('/api/autosync/status'),
  resolveSession: (id: string): Promise<ResolveSessionResult> => j(`/api/sessions/${encodeURIComponent(id)}/resolve`),
  gitAt: (project: number | string, ts: string): Promise<GitAtResult> =>
    j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project: number | string, commit: string): Promise<GitTreeResult> =>
    j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project: number | string, commit: string, path: string): Promise<GitFileResult> =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
  insights: (days?: number): Promise<InsightsResult> => j('/api/insights' + (days ? `?days=${days}` : '')),
};
