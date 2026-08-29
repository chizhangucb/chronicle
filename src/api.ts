// Client fetch wrapper — every Chronicle REST endpoint in one place. Response
// shapes are declared locally where the server doesn't already export a type
// (see server/routes/*.ts); shared entities (Project, scan shapes) come from
// `@shared/types.ts`. `fetch`'s `res.json()` return is `unknown` at the type
// level — cast it once per call to the shape the route actually sends.
import type { Kind, Project, ScannedProject, ScannedSession, SourceId } from '@shared/types.ts';
import type {
  MemoryNode, MemoryLink, MemoryScopeEcho,
  MemoryRot, MemoryGrowth, MemoryUsage, MemoryConnectivity, MemoryNoteDate,
} from './components/memory/types.js';
import { gateToken } from './gate/token.ts';

// Mutating methods carry the per-boot gate token (CHI-323 D2). Every write in
// the app funnels through j(), so attaching the token here is the whole client
// half of "token on all writes" — no per-call plumbing.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const method = (opts?.method ?? 'GET').toUpperCase();
  const once = async (refetch: boolean): Promise<Response> => {
    if (!MUTATING.has(method)) return fetch(url, opts);
    const headers = { ...(opts?.headers as Record<string, string> | undefined), 'x-gate-token': await gateToken(refetch) };
    return fetch(url, { ...opts, headers });
  };
  let res = await once(false);
  // The per-boot token rotates on a server restart; one refetch+retry recovers
  // an open tab (matches Varde's tokenPost). Retry only the CSRF 403, mutating only.
  if (res.status === 403 && MUTATING.has(method)) res = await once(true);
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
    // Was missing from this type despite the server always returning it
    // (server/routes/projects.ts) -- found while scoping CHI-228, whose fix
    // touches this exact field. Day-bucketed (BucketedUsageCell, not
    // WindowedUsageCell) so a session straddling a rate change prices
    // correctly. src/ProjectDetail.tsx's actual fetch uses its own local
    // ProjectDetailData/ProjectAnalytics types, not this one (this type's
    // only other reader, SessionView.tsx, only reads `.sessions`) -- kept in
    // sync here for accuracy, not unified into one type (out of scope for
    // a pricing fix).
    windowedTokensByModel: BucketedUsageCell[];
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

// ---- View log (CHI-325 3a) ----
// Mirrors server/viewlog.ts. Local-only: these shapes never travel anywhere but
// between this client and the localhost server that owns chronicle.db.
export type ViewLogActor = 'human' | 'agent';
export type ViewLogEvent = 'visit' | 'tab' | 'action';

export interface ViewLogEventInput {
  /** Route PATTERN ('/session/:id'), never an instance. The server rejects
   *  anything not on its allowlist, which is what keeps this table from
   *  becoming a second copy of the session history. */
  route: string;
  event: ViewLogEvent;
  detail?: string | null;
  actor: ViewLogActor;
  gesture: boolean;
}

/** Fills in the dwell of a row opened earlier. Rows are opened on ARRIVAL so a
 *  lost close costs one duration, never a whole visit (see server/viewlog.ts). */
export interface ViewLogClose {
  id: number;
  dwellMs: number;
}

export interface ViewLogRouteSummary {
  route: string;
  humanVisits: number;
  agentVisits: number;
  humanDwellMs: number | null;
}

export interface ViewLogSummary {
  enabled: boolean;
  rows: number;
  humanRows: number;
  agentRows: number;
  firstTs: string | null;
  lastTs: string | null;
  routes: ViewLogRouteSummary[];
}

export interface Settings {
  autoSync: boolean;
  autoSyncPaused: boolean;
  ask: boolean;
  minorActiveMsThreshold: number;
  minorMessageCountThreshold: number;
  planWindows: boolean;
  // Monthly spend budget in USD, or null when unset (CHI-366). Server-visible so
  // the Spend tab and the briefing runner read the same value.
  monthlyBudget: number | null;
  /** The briefing + status bands on / (CHI-325 3d). Default true. */
  homeBands: boolean;
}

// Subscription plan windows (CHI-324 2f) — mirrors server/planWindows.ts. One
// card per ACCOUNT. Codex is local (always); Claude is OUTBOUND + opt-in-off.
export interface AccountWindow { label: string; utilization: number; resetsAt: string | null; }
export interface PlanAccount { name: string; kind: 'claude' | 'codex'; plan: string | null; windows: AccountWindow[]; }
export interface PlanWindowsResult { claudeEnabled: boolean; claudeUnauthed: boolean; accounts: PlanAccount[]; }
export function planWindowsUrl(): string { return '/api/plan-windows'; }

// ---- /ask (CHI-351): local claude-CLI-backed metric chat over chronicle.db ----
export interface AskStatus {
  enabled: boolean;      // toggleOn && claudePresent && !demo
  toggleOn: boolean;
  claudePresent: boolean;
  demo: boolean;
}
export type AskCostMode = 'list' | 'billed';
export interface AskTurn {
  id: string;
  ts: string;
  question: string;
  costBasis: AskCostMode;
  ok: boolean;
  prose: string;
  sql: string | null;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  note?: string;
  error?: string;
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
  // See the WindowedUsageCell/BucketedUsageCell comment above. Day-bucketed
  // (CHI-228, was WindowedUsageCell[]) so the client can price a range that
  // straddles a rate change (e.g. Sonnet 5's intro window) correctly per day.
  windowedTokensByModel: BucketedUsageCell[];
  dailySpend: BucketedUsageCell[];
  // Only computed server-side (non-null) for a short window (days<=2) — the
  // client falls back to dailySpend otherwise (see server/insights.ts).
  hourlySpend: BucketedUsageCell[] | null;
  // Machine-session manifest (CHI-233 Part C) — mirrors server/machineSessions.ts.
  // See MachineSessionsResult below.
  machineSessions: MachineSessionsResult;
}

// Machine-session manifest (mirrors server/machineSessions.ts VERBATIM). The
// set of AUTOMATION (headless machine `claude -p`) session_ids in range, plus
// per-session job/model/raw token CELLS (server ships cells, the client prices
// them via models.ts costOf — the price table stays client-side). `cost_usd` is
// a convenience fallback only (prefer recomputing from `usage`).
export interface MachineUsageCells { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; }
export interface MachineSession {
  sessionId: string;
  job: string;
  model: string | null;
  usage: MachineUsageCells;
  cost_usd: number | null;
  ts: string | null;
}
export interface MachineSessionsResult {
  ids: string[];
  sessions: MachineSession[];
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
  // Day-bucketed (CHI-228) breakdown of windowSpendTokensByModel — see
  // server/activity.ts's ActivityBurn comment for why only this field (not
  // baseline/topSession) is day-bucketed.
  windowSpendTokensByModelByDay: Record<string, ActivityTokensByModel>;
  baselineTokensByModel: ActivityTokensByModel;
  topSessionId: string | null; topSessionName: string | null;
  topSessionTokensByModel: ActivityTokensByModel;
  // CHI-324 2c: per-day per-dimension cells for the anomaly tile (client prices
  // → CostedDay[] → shared computeAnomaly), Lane C per-day $, and the local today.
  anomalyDays: AnomalyDayCells[];
  laneCByDay: Record<string, number>;
  today: string;
}
export interface AnomalyDayCells {
  day: string;
  byModel: ActivityTokensByModel;
  byProject: Record<string, ActivityTokensByModel>;
  bySource: Record<string, ActivityTokensByModel>;
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
  // Day-bucketed (CHI-228) breakdown of tokensByModel, for EXACT_USAGE_GROUPS
  // rows (model/project/source/session) only — see server/explore.ts's
  // ExploreRow comment.
  tokensByModelByDay?: Record<string, Record<string, ModelUsageCell>>;
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
  group: 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session' | 'mcp' | 'provider';
  subgroup: 'model' | 'project' | 'source' | 'tool' | 'skill' | 'subagent' | 'hour' | 'session' | 'mcp' | 'provider' | null;
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
  group: 'model'|'project'|'source'|'tool'|'skill'|'subagent'|'hour'|'session'|'mcp'|'provider';
  subgroup?: 'model'|'project'|'source'|'tool'|'skill'|'subagent'|'hour'|'session'|'mcp'|'provider'; topN?: number;
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
// Efficiency detector counts (CHI-324 2e) — mirrors server/detectors.ts. The
// client derives + grades the rates (cache hit, jumbo, long context) with the
// shared thresholds; error rate is derived from /api/insights.
export interface DetectorCounts {
  assistantRows: number;
  jumboRows: number;
  longContextRows: number;
  cacheReadTokens: number;
  inputTokens: number;
}
export function detectorsUrl(days?: number | null): string {
  const p = new URLSearchParams();
  if (days) p.set('days', String(days));
  const qs = p.toString();
  return '/api/detectors' + (qs ? `?${qs}` : '');
}

// Efficiency WASTE signals (CHI-324 2e) — mirrors server/waste.ts. Ships token
// cells + counts; the client prices the premium / savings / wasted-$.
export interface WasteChurnSession { session: string; project: string; writeTokens: number; readTokens: number; byModel: Record<string, { cw5m: number; cw1h: number }>; }
export interface WasteRightSizingModel { model: string; messages: number; input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; }
export interface WasteRereadFile { path: string; rereads: number; sessions: number; }
export interface WasteResult {
  cacheChurn: { sessionsFlagged: number; top: WasteChurnSession[] };
  rightSizing: { candidates: WasteRightSizingModel[] };
  rereads: { rereadCalls: number; sessionsAffected: number; estWastedTokens: number; topFiles: WasteRereadFile[] };
}
export function wasteUrl(days?: number | null): string {
  const p = new URLSearchParams();
  if (days) p.set('days', String(days));
  const qs = p.toString();
  return '/api/waste' + (qs ? `?${qs}` : '');
}

// Routing-compliance roster (CHI-324 2e) — mirrors server/routing.ts. Just the
// curated model families; the client classifies the window's models on/off
// roster and prices from /api/insights. Hub-conditional.
export interface RosterResult { present: boolean; families: string[]; }
export function routingUrl(): string { return '/api/routing'; }
export function contentUrl(scope: 'all' | 'project' | 'session', id?: string | number, days?: number | null): string {
  const p = new URLSearchParams({ scope });
  if (id != null) p.set('id', String(id));
  if (days) p.set('days', String(days));
  return '/api/content?' + p.toString();
}

// ---- Hub adapter (CHI-323) ----
export type HubMode = 'live' | 'demo' | 'absent';
export interface HubStatus {
  present: boolean;
  mode: HubMode;
  root?: string | null;
  reason?: string;
}
export interface ModuleContractView {
  status: 'full' | 'pending' | 'grandfathered';
  raw: string;
  pendingTicket: string | null;
  path: string | null;
  available: boolean;
  markdown: string | null;
}
export interface ModuleRowView {
  name: string; tier: string; purpose: string; prdHome: string; project: string;
  contract: ModuleContractView;
}
export interface ModulesSliceView { found: boolean; rows: ModuleRowView[] }
// The route sends the slice when the hub is present, or this sentinel when absent.
export type ModulesResult = ModulesSliceView | { hubPresent: false };

// Safety (organ 1d)
export interface SafetyNetView {
  found: boolean;
  gateConfig: { enabled: boolean; spend_per_tx_cap: number | null; spend_per_session_cap: number | null; unclassified_deny_daily_cap: number | null } | null;
  classification: { tools: { name: string; class: string }[] } | null;
  markers: { categories: { category: string; count: number }[] };
  proxyServers: { names: string[] } | null;
}
export interface GapView {
  id: string; kind: 'actionable' | 'watch'; title: string; exposure: string; acceptedWhy: string;
  acceptedDate: string; blastRadius: string; closingEdit?: { surface: string; label: string };
  revisitTrigger?: string; links: string[];
}
export interface SafetyGapsView {
  header: string; actionable: GapView[]; watch: GapView[];
  posture: { classificationRules: number; markerCategories: { category: string; count: number }[]; spendCaps: Record<string, number | null>; egressEnabled: boolean };
}
export interface SafetyResult {
  safetyNet: SafetyNetView;
  gaps: SafetyGapsView;
  egress: { enabled: boolean; gateConfigFound: boolean };
}
export type HubSafetyResult = SafetyResult | { hubPresent: false };
export interface LaunchGapResult { launched: boolean; buffer?: string; copyPrompt?: string; reason?: string }

// Jobs (organ 1e)
export type JobSource = 'launchd' | 'cron' | 'registry' | 'repo-template';
export type JobStatus = 'success' | 'failed' | 'stale' | 'pending' | 'running' | 'not-installed' | 'disabled' | 'paused';
export interface JobRowView {
  id: string; name: string; source: JobSource; schedule: string; scheduleKind: string;
  nextRun: string | null; lastRun: string | null; lastRunAt: string | null; status: JobStatus;
  lastExit: number | null; runner: string | null; model: string | null; agent: string | null;
  project: string | null; projectPath: string | null; command: string; logPath: string | null;
  errLogPath?: string | null; missingPath?: string | null; description?: string | null; meta?: string;
}
export interface JobsSliceView { scannedAt: string; sources: Record<JobSource, number>; jobs: JobRowView[] }
export type HubJobsResult = JobsSliceView | { hubPresent: false };

// Records (CHI-324 2h) — the append-only hub records, index fields only.
export interface RecordsLedgerRowView { date: string; sessionId: string; focus: string; repo: string | null }
export interface RecordsDecisionView { date: string | null; title: string }
export interface RecordsSliceView {
  found: boolean;
  decisions: { total: number; recent: RecordsDecisionView[] };
  ledger: { total: number; recent: RecordsLedgerRowView[]; rows: RecordsLedgerRowView[] };
}
export type HubRecordsResult = RecordsSliceView | { hubPresent: false };
export interface LogTailView { path: string; exists: boolean; lines: string[]; truncated: boolean }
export interface JobLogResult { id: string; stdout: LogTailView | null; stderr: LogTailView | null }

// Briefing (organ 1f)
export type BriefingDomainView = 'memory' | 'sessions' | 'safety' | 'jobs' | 'coverage';
export type CardStateView = 'open' | 'done' | 'dismissed' | 'snoozed' | 'resolved';
export type CardActionView = 'done' | 'dismiss' | 'snooze' | 'reopen';
export interface ResolvedCardView {
  id: string; runAt: string; kind: string; domain: BriefingDomainView; needsYou: boolean;
  title: string; summary: string; body?: string; whatHappened?: string; whatItMeans?: string;
  whatToDo?: string; evidence?: string; link?: { label: string; to: string }; launch?: { prompt: string; cwd?: string };
  state: CardStateView; actedAt: string | null; snoozedUntil: string | null; workedAt: string | null; ticketRef: string | null;
}
export interface FollowThroughView {
  open: number; snoozed: number; actedWithinDays: number | null; followThroughDays: number; medianHoursToAct: number | null;
}
export interface BriefingResult { generatedAt: string; cadence: string; cards: ResolvedCardView[]; followThrough: FollowThroughView }
export interface BriefingRunStatus { running: boolean; startedAt: string | null; lastResult: { ok: boolean; code: number | null; at: string } | null }

// Memory (organ 1g). The node/link shapes mirror src/components/memory/types.ts.
export interface MemoryStatsView {
  totalFiles: number; totalWorkspaces: number; stale: number; missing: number; freshness: number;
  capSuggested: number; totalNotes: number; totalLinks: number; living: number; historical: number;
}
/** The home band's memory read (CHI-325 3d). Deliberately tiny: the full
 *  MemorySliceView carries every node and link, which must not travel to the
 *  default route on every load. */
export interface MemorySummaryView {
  hubPresent: true;
  totalNotes: number;
  totalLinks: number;
  stale: number;
  freshness: number;
  growth: number[];
}

export interface MemorySliceView {
  stats: MemoryStatsView;
  scope: MemoryScopeEcho;
  nodes: MemoryNode[];
  links: MemoryLink[];
  // The rich analytics reads (CHI-385 parity): the Memory lanes read these
  // directly. They ship from the server slice; the canvas uses stats + scope +
  // nodes + links. Optional: an older projection may omit any of them.
  rot?: MemoryRot;
  growth?: MemoryGrowth;
  usage?: MemoryUsage;
  connectivity?: MemoryConnectivity;
  noteDates?: MemoryNoteDate[];
  [key: string]: unknown;
}
export type HubMemoryResult = MemorySliceView | { hubPresent: false };
export interface OpenFileResult { ok: boolean; opened?: string; error?: string }

// Memory scope-suggest (CHI-339, the 1g fast-follow): mirrors the briefing
// run/run-status pair. Nothing writes here; a returned suggestion becomes a
// gate proposal via the existing gatePropose('memory-scope', ...).
export interface ScopeSuggestion { living: string[]; historical: string[]; excluded: string[] }
export interface ScopeSuggestStatus { running: boolean; suggestion: ScopeSuggestion | null; error: string | null }

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
  // Hub adapter (CHI-323): ops surfaces read these. status gates all ops nav.
  hubStatus: (): Promise<HubStatus> => j('/api/hub/status'),
  hubModules: (): Promise<ModulesResult> => j('/api/hub/modules'),
  hubSafety: (): Promise<HubSafetyResult> => j('/api/hub/safety'),
  launchGap: (id: string): Promise<LaunchGapResult> => j('/api/launch/gap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }),
  hubJobs: (): Promise<HubJobsResult> => j('/api/hub/jobs'),
  hubRecords: (): Promise<HubRecordsResult> => j('/api/hub/records'),
  jobLog: (id: string): Promise<JobLogResult | { hubPresent: false }> => j(`/api/jobs/log?id=${encodeURIComponent(id)}`),
  briefing: (): Promise<BriefingResult> => j('/api/briefing'),
  briefingAction: (cardId: string, action: CardActionView): Promise<{ cards: ResolvedCardView[]; followThrough: FollowThroughView }> =>
    j('/api/briefing/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, action }) }),
  briefingRun: (): Promise<{ started: boolean }> => j('/api/briefing/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  briefingRunStatus: (): Promise<BriefingRunStatus> => j('/api/briefing/run-status'),
  hubMemory: (): Promise<HubMemoryResult> => j('/api/hub/memory'),
  // /ask (CHI-351)
  askStatus: (): Promise<AskStatus> => j('/api/ask/status'),
  askHistory: (): Promise<{ turns: AskTurn[] }> => j('/api/ask/history'),
  postAsk: (question: string, costMode: AskCostMode): Promise<{ turn: AskTurn }> => j('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, costMode }),
  }),
  openFile: (nodePath: string): Promise<OpenFileResult> => j('/api/open-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: nodePath }),
  }),
  scopeSuggestStart: (): Promise<{ started: boolean }> => j('/api/memory/scope-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }),
  scopeSuggestStatus: (): Promise<ScopeSuggestStatus> => j('/api/memory/scope-suggest/status'),
  // Project source ops (were raw fetches in ProjectDetail.tsx; routed through j
  // so they carry the gate token like every other write, CHI-323 review #2).
  associateProject: (id: number | string, path: string): Promise<unknown> => j(`/api/projects/${id}/associate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  }),
  unlinkProjectSource: (id: number | string, source: string): Promise<unknown> => j(`/api/projects/${id}/unlink`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }),
  }),
  // Security-rule CRUD (were raw fetches in SecurityCheck.tsx; same reason).
  createSecurityRule: (rule: { pattern: string; replacement: string; kind: string; name: string }): Promise<unknown> =>
    j('/api/security/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) }),
  deleteSecurityRule: (id: number): Promise<unknown> => j(`/api/security/rules/${id}`, { method: 'DELETE' }),
  toggleSecurityRule: (id: number, enabled: boolean): Promise<unknown> =>
    j(`/api/security/rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }),
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
  // View log (CHI-325 3a). The POST is batched (a navigation closes the previous
  // dwell and opens the next), and it rides j() so the gate token is attached —
  // server/api.ts 403s every non-GET without it.
  viewLog: (events: ViewLogEventInput[], closes: ViewLogClose[] = []): Promise<{ ids: (number | null)[]; recorded: number; closed: number; enabled: boolean }> =>
    j('/api/view-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events, closes }) }),
  viewLogSummary: (): Promise<ViewLogSummary> => j('/api/view-log/summary'),
  // Demo mode (CHI-325 3c). `available` is false under `npm run dev`, where
  // there is no CLI to restart the process.
  demoStatus: (): Promise<{ demo: boolean; available: boolean }> => j('/api/demo/status'),
  // LIGHT memory read for the home status band (CHI-325 3d): four numbers plus a
  // growth series, never the whole node/link graph.
  hubMemorySummary: (): Promise<MemorySummaryView | { hubPresent: false }> => j('/api/hub/memory/summary'),
  demoStart: (): Promise<{ ok: true; restarting: boolean }> =>
    j('/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  demoExit: (): Promise<{ ok: true; restarting: boolean }> =>
    j('/api/demo/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  viewLogClear: (): Promise<{ cleared: number }> => j('/api/view-log', { method: 'DELETE' }),
  viewLogSetEnabled: (viewLog: boolean): Promise<{ enabled: boolean }> =>
    j('/api/view-log/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewLog }) }),
};
