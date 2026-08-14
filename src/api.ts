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

// Exported for `useCachedFetch.ts` (Task 5, client SWR layer): the hook takes
// a plain URL string, not an `api.*` call, so it needs the same fetch+error-
// message-extraction behavior every `api.*` function already gets from `j`
// — reusing it (rather than a bare `fetch`) keeps error shape identical to
// pre-hook code (e.g. ProjectDetail's rename/associate error banners).
export const fetchJson = j;

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
  // Any session in the project has an open live watcher or ended in the last
  // 5 minutes (server/routes/projects.ts, Task 17).
  live: boolean;
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
  workflow_id: string | null;
  agent_id: string | null;
  agent_desc: string | null;
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
  // Empty-query "recent" branch only: page offset for the Home ledger's
  // lazy-scroll (server returns 50 per page). See server/routes/search.ts.
  offset?: number;
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

// Windowed billed cells (feedback-round Task 2/3): per-session, per-model,
// in-window-scaled token cells — mirrors server/windowUsage.ts's
// WindowedUsageCell/BucketedUsageCell VERBATIM (same field names; the server
// returns these as plain JSON, no adapter needed). The client prices these via
// src/models.ts costOf (src/windowedUsage.ts's aggregation helpers) instead of
// summing raw `sessions.usage`, so a session that started before the active
// window but ran INTO it contributes only its in-window share.
export interface WindowedUsageCell {
  sessionId: string;
  projectId: number;
  model: string;
  source: string;
  cells: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
}
export interface BucketedUsageCell extends WindowedUsageCell {
  bucket: string;
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
  laneC: LaneCSpend;
  // See the WindowedUsageCell/BucketedUsageCell comment above.
  windowedTokensByModel: WindowedUsageCell[];
  dailySpend: BucketedUsageCell[];
  // Only computed server-side (non-null) for a short window (days<=2) — the
  // client falls back to dailySpend otherwise (see server/insights.ts).
  hourlySpend: BucketedUsageCell[] | null;
}

// Lane C proxy-lane billed spend (mirrors server/laneC.ts) — authoritative
// billed $ by model, not session-linked.
export interface LaneCModel { model: string; spend: number; requests: number; tokens: number; }
export interface LaneCSpend { totalSpend: number; requests: number; byModel: LaneCModel[]; }

// ---- Home dashboard activity feed (Task 13) — mirrors server/activity.ts ----
// Every token figure is a per-model CELL; the client prices it via
// models.ts costOf (the price table stays client-side — hard constraint).
export interface ActivityTokenCell { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; }
export type ActivityTokensByModel = Record<string, ActivityTokenCell>;
export interface ActivitySessionLite {
  id: string; name: string; projectName: string; source: string;
  live: boolean; endedAt: string | null;
  tokensByModel: ActivityTokensByModel; errorCount: number;
}
export interface ActivityBurn {
  windowSpendTokensByModel: ActivityTokensByModel;
  baselineTokensByModel: ActivityTokensByModel;
  topSessionId: string | null; topSessionName: string | null;
  topSessionTokensByModel: ActivityTokensByModel;
}
export interface ActivityResult {
  live: ActivitySessionLite[]; recent: ActivitySessionLite[]; burn: ActivityBurn;
}

// ---- Explore / Content (Task 5e-0 backend engine) ----
// These interfaces mirror server/explore.ts and server/content.ts VERBATIM —
// keep them in sync if the server types change.

export type ExploreRollup = 'total' | 'hourly' | 'daily' | 'weekly' | 'monthly';
export interface ModelUsageCell { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }
export interface ExploreRow {
  key: string; label: string;
  tokensByModel: Record<string, ModelUsageCell>;
  requests: number; sessions: number; errors: number; activeMs: number;
  segments: { key: string; label: string; tokens: number }[];
  // Only set on the synthetic key==='Other' row — count of folded-in group
  // values, read by the "+N in Other" legend.
  otherCount?: number;
}
// One (bucket × series) cell in a time-rollup — metric-specialized (only the
// dimension the chosen metric reads is populated). Structurally a superset of
// what metricValue/rowSpend/rowTokens read, so those helpers accept it directly.
export interface ExploreCell {
  tokensByModel: Record<string, ModelUsageCell>;
  requests: number; sessions: number; errors: number; activeMs: number;
}
export interface ExploreBucket { bucket: string; label: string; series: Record<string, ExploreCell>; }
export interface ExploreResult {
  metric: 'spend' | 'tokens' | 'requests' | 'active' | 'sessions' | 'errors';
  group: 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session';
  subgroup: 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session' | null;
  calibrated: boolean; rows: ExploreRow[];
  rollup: ExploreRollup; requestedRollup: ExploreRollup; buckets?: ExploreBucket[];
}

// D4 (feedback-round Task 12): the client never branches on `key` — every
// field a row needs to render (label/why/info/format/value) travels on the
// Characteristic itself, mirroring server/content.ts's Characteristic
// contract exactly (this type is intentionally NOT imported from the server
// module — the client/server split is the existing convention in this file,
// see e.g. ExploreResult above).
export type CharacteristicFormat = 'percent' | 'tokens' | 'hours';

export interface Characteristic {
  key: string;
  label: string;
  why: string;
  info: string;
  format: CharacteristicFormat;
  value: number;
  value2?: number;
  warn?: boolean;
  count?: number;
  countOne?: string;
  countMany?: string;
  exact: boolean;
}

export interface ContentResult {
  composition: { key: string; tokens: number }[];
  toolResultsByTool: { key: string; tokens: number }[];
  skills: { key: string; count: number; tokens: number }[];
  subagents: { key: string; runs: number; tokens: number }[];
  // At 'all'/'project' scope: 7 token-share characteristics. At 'session'
  // scope: 6 absolute session facts (threshold predicates that collapse to
  // 0%/100% at N=1 are replaced — see server/content.ts).
  characteristicsScope: 'all' | 'project' | 'session';
  characteristics: Characteristic[];
  calibratedTotalTokens: number;
  // composition, toolResultsByTool, and skills[].tokens are calibrated
  // (text-length→billed); subagents[].tokens are exact.
  calibrated: boolean;
}

export interface ExploreQueryParams {
  scope: 'all' | 'project' | 'session'; id?: string | number; days?: number | null;
  metric: 'spend'|'tokens'|'requests'|'active'|'sessions'|'errors';
  group: 'model'|'project'|'source'|'tool'|'skill'|'subagent'|'hour'|'session';
  subgroup?: 'model'|'project'|'source'|'tool'|'skill'|'subagent'|'hour'|'session'; topN?: number;
  rollup?: ExploreRollup;
}

// ---- Git ----

export type GitAtResult = { commit: Commit | null } | { noRepo: true };
export type GitTreeResult = { files: string[]; changed: string[] } | { noRepo: true };
export type GitFileResult =
  | { content: string | null; previous: string | null; prevCommit: string | null; changedInCommit: boolean }
  | { noRepo: true };

// ---- Pure URL builders (Task 5) ----
// Kept separate from the fetching `api.*` functions below so `useCachedFetch`
// (which takes a URL string, not a promise-returning call) can build the
// exact same query string each surface already builds, then let the hook own
// the fetch/cache/error lifecycle. `api.insights`/`explore`/`content`/`project`
// below delegate to these so the two never drift.
export function projectsUrl(): string { return '/api/projects'; }
export function projectUrl(id: number | string, days?: number | string): string {
  return `/api/projects/${id}${days ? `?days=${days}` : ''}`;
}
export function insightsUrl(days?: number): string {
  return '/api/insights' + (days ? `?days=${days}` : '');
}
export function exploreUrl(q: ExploreQueryParams): string {
  const p = new URLSearchParams({ scope: q.scope, metric: q.metric, group: q.group });
  if (q.id != null) p.set('id', String(q.id));
  if (q.days) p.set('days', String(q.days));
  if (q.subgroup) p.set('subgroup', q.subgroup);
  if (q.topN) p.set('topN', String(q.topN));
  if (q.rollup && q.rollup !== 'total') p.set('rollup', q.rollup);
  return '/api/explore?' + p.toString();
}
export function activityUrl(since?: string | null, days?: number | null): string {
  const p = new URLSearchParams();
  if (since) p.set('since', since);
  if (days) p.set('days', String(days));
  const qs = p.toString();
  return '/api/activity' + (qs ? `?${qs}` : '');
}
export function contentUrl(scope: 'all' | 'project' | 'session', id?: string | number, days?: number | null): string {
  const p = new URLSearchParams({ scope });
  if (id != null) p.set('id', String(id));
  if (days) p.set('days', String(days));
  return '/api/content?' + p.toString();
}

export const api = {
  scan: (params?: ScanParams): Promise<ScanResult> =>
    j('/api/scan' + (params ? `?${new URLSearchParams(params as Record<string, string>)}` : '')),
  import: (payload: ImportPayload): Promise<ImportResult> => j('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  projects: (): Promise<ProjectListItem[]> => j(projectsUrl()),
  renameProject: (id: number | string, name: string): Promise<Project> => j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  deleteProject: (id: number | string): Promise<{ ok: true }> => j(`/api/projects/${id}`, { method: 'DELETE' }),
  syncProject: (id: number | string): Promise<SyncResult> => j(`/api/projects/${id}/sync`, { method: 'POST' }),
  project: (id: number | string, days?: number | string): Promise<ProjectDetail> =>
    j(projectUrl(id, days)),
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
  runAutosync: (): Promise<AutosyncStatus['lastResult']> => j('/api/autosync/run', { method: 'POST' }),
  // Open live-watcher list (server/live.ts liveStatus()) — used to detect "a
  // session in this project/view is live" from state that didn't necessarily
  // originate from THIS tab's own EventSource (another tab, or a test's raw
  // EventSource against the same session).
  liveWatchers: (): Promise<{ sessionId: string; file?: string; clients: number; offset?: number }[]> => j('/api/live/status'),
  resolveSession: (id: string): Promise<ResolveSessionResult> => j(`/api/sessions/${encodeURIComponent(id)}/resolve`),
  gitAt: (project: number | string, ts: string): Promise<GitAtResult> =>
    j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project: number | string, commit: string): Promise<GitTreeResult> =>
    j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project: number | string, commit: string, path: string): Promise<GitFileResult> =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
  insights: (days?: number): Promise<InsightsResult> => j(insightsUrl(days)),
  explore: (q: ExploreQueryParams): Promise<ExploreResult> => j(exploreUrl(q)),
  content: (scope: 'all'|'project'|'session', id?: string|number, days?: number|null): Promise<ContentResult> =>
    j(contentUrl(scope, id, days)),
};
