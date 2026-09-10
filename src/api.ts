// The client's fetch layer, and nothing else (#307, audit F10/F23).
//
// Every read and every write the app makes goes through this module: one place
// that attaches the write token, retries the token rotation, turns a non-OK
// response into an Error carrying the server's message, and builds each URL.
// The SHAPES it returns are not declared here — they live in shared/ (rows.ts,
// results.ts, explore.ts, usage.ts) and are imported by the server engines that
// compute them and by the components that render them, so a response shape has
// one declaration and no component keeps a copy.
import type { Project } from '../shared/types.ts';
import type { MinorSessionRow, SecurityRuleRow } from '../shared/rows.ts';
import type { ExploreQueryParams, ExploreWireResult } from '../shared/explore.ts';
import type {
  AskCostMode, AskStatus, AskTurn, AutosyncStatus, ContentResult,
  DeleteSessionResult, GitAtResult, GitFileResult, GitTreeResult,
  ImportPayload, ImportResult, InsightsResult, LiveWatcher, ProjectDetailResult,
  ProjectListItem, RenameSessionResult, ResolveSessionResult, ScanParams, ScanResult,
  SearchParams, SearchResponse, SecurityScanResult, SessionMessagesResult,
  SessionSyncResult, Settings, SettingsPatch, SyncRunResult,
} from '../shared/results.ts';
import { writeToken, WRITE_TOKEN_HEADER } from './writeToken.ts';

// Mutating methods carry the per-boot write token. Every write in
// the app funnels through j(), so attaching the token here is the whole client
// half of "token on all writes" — no per-call plumbing.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const method = (opts?.method ?? 'GET').toUpperCase();
  const once = async (refetch: boolean): Promise<Response> => {
    if (!MUTATING.has(method)) return fetch(url, opts);
    const headers = { ...(opts?.headers as Record<string, string> | undefined), [WRITE_TOKEN_HEADER]: await writeToken(refetch) };
    return fetch(url, { ...opts, headers });
  };
  let res = await once(false);
  // The per-boot token rotates on a server restart; one refetch+retry recovers
  // an open tab. Retry only the CSRF 403, mutating only.
  if (res.status === 403 && MUTATING.has(method)) res = await once(true);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message = (body && typeof body === 'object' && 'error' in body) ? (body as { error?: string }).error : undefined;
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Exported for `useCachedFetch.ts` (the client's stale-while-revalidate
// layer): the hook takes a plain URL string, not an `api.*` call, so it needs
// the same fetch + error-message extraction every `api.*` function gets from
// `j` — reusing it (rather than a bare `fetch`) keeps the error shape identical
// on both paths (e.g. ProjectDetail's rename/associate error banners).
export const fetchJson = j;

// ---- Pure URL builders ----
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
export function detectorsUrl(days?: number | null): string {
  const p = new URLSearchParams();
  if (days) p.set('days', String(days));
  const qs = p.toString();
  return '/api/detectors' + (qs ? `?${qs}` : '');
}

export function wasteUrl(days?: number | null): string {
  const p = new URLSearchParams();
  if (days) p.set('days', String(days));
  const qs = p.toString();
  return '/api/waste' + (qs ? `?${qs}` : '');
}

// Subscription plan windows: one card per ACCOUNT (server/planWindows.ts).
// Codex is local (always); Claude is the one OUTBOUND read, opt-out, default on.
export function planWindowsUrl(): string { return '/api/plan-windows'; }

function securityCheckUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/security-check`;
}
function securityRulesUrl(): string { return '/api/security/rules'; }

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
  syncProject: (id: number | string): Promise<SyncRunResult> => j(`/api/projects/${id}/sync`, { method: 'POST' }),
  project: (id: number | string, days?: number | string): Promise<ProjectDetailResult> =>
    j(projectUrl(id, days)),
  search: (params: SearchParams): Promise<SearchResponse> =>
    j('/api/search?' + new URLSearchParams(params as Record<string, string>)),
  sessionMessages: (id: string): Promise<SessionMessagesResult> => j(`/api/sessions/${encodeURIComponent(id)}/messages`),
  renameSession: (id: string, name: string): Promise<RenameSessionResult> => j(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  syncSession: (id: string): Promise<SessionSyncResult> => j(`/api/sessions/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  deleteSession: (id: string): Promise<DeleteSessionResult> =>
    j(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  undoDeleteSession: (source: string, id: string): Promise<{ ok: true }> => j('/api/sessions/undo-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, id }),
  }),
  minorSessions: (): Promise<MinorSessionRow[]> => j('/api/sessions/minor'),
  promoteSession: (id: string): Promise<{ ok: true }> => j(`/api/sessions/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  settings: (): Promise<Settings> => j('/api/settings'),
  patchSettings: (patch: SettingsPatch): Promise<Settings> => j('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }),
  autosyncStatus: (): Promise<AutosyncStatus> => j('/api/autosync/status'),
  runAutosync: (): Promise<AutosyncStatus['lastResult']> => j('/api/autosync/run', { method: 'POST' }),
  // /ask
  askStatus: (): Promise<AskStatus> => j('/api/ask/status'),
  askHistory: (): Promise<{ turns: AskTurn[] }> => j('/api/ask/history'),
  postAsk: (question: string, costMode: AskCostMode): Promise<{ turn: AskTurn }> => j('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, costMode }),
  }),
  // Project source ops (were raw fetches in ProjectDetail.tsx; routed through j
  // so they carry the write token like every other write).
  associateProject: (id: number | string, path: string): Promise<unknown> => j(`/api/projects/${id}/associate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  }),
  unlinkProjectSource: (id: number | string, source: string): Promise<unknown> => j(`/api/projects/${id}/unlink`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }),
  }),
  // Security-rule CRUD (were raw fetches in SecurityCheck.tsx; same reason).
  createSecurityRule: (rule: { pattern: string; replacement: string; kind: string; name: string }): Promise<unknown> =>
    j(securityRulesUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) }),
  deleteSecurityRule: (id: number): Promise<unknown> => j(`${securityRulesUrl()}/${id}`, { method: 'DELETE' }),
  toggleSecurityRule: (id: number, enabled: boolean): Promise<unknown> =>
    j(`${securityRulesUrl()}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }),
  // Open live-watcher list (server/live.ts liveStatus()) — used to detect "a
  // session in this project/view is live" from state that didn't necessarily
  // originate from THIS tab's own EventSource (another tab, or a test's raw
  // EventSource against the same session).
  liveWatchers: (): Promise<LiveWatcher[]> => j('/api/live/status'),
  resolveSession: (id: string): Promise<ResolveSessionResult> => j(`/api/sessions/${encodeURIComponent(id)}/resolve`),
  gitAt: (project: number | string, ts: string): Promise<GitAtResult> =>
    j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project: number | string, commit: string): Promise<GitTreeResult> =>
    j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project: number | string, commit: string, path: string): Promise<GitFileResult> =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
  insights: (days?: number): Promise<InsightsResult> => j(insightsUrl(days)),
  explore: (q: ExploreQueryParams): Promise<ExploreWireResult> => j(exploreUrl(q)),
  content: (scope: 'all' | 'project' | 'session', id?: string | number, days?: number | null): Promise<ContentResult> =>
    j(contentUrl(scope, id, days)),
  // The redaction preview and its rule list (were raw fetches in
  // SecurityCheck.tsx, with their own copies of the two shapes).
  securityCheck: (sessionId: string): Promise<SecurityScanResult> =>
    j(securityCheckUrl(sessionId)),
  securityRules: (): Promise<SecurityRuleRow[]> => j(securityRulesUrl()),
  // Demo mode. `available` is false under `npm run dev`, where
  // there is no CLI to restart the process.
  demoStatus: (): Promise<{ demo: boolean; available: boolean }> => j('/api/demo/status'),
  demoStart: (): Promise<{ ok: true; restarting: boolean }> =>
    j('/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  demoExit: (): Promise<{ ok: true; restarting: boolean }> =>
    j('/api/demo/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
};
