import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import * as Popover from '@radix-ui/react-popover';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, projectUrl, projectsUrl } from './api.js';
import { t } from './i18n.js';
import { costOf, type ModelUsageInput } from './models.js';
import { useSessionSelect, type DeletedEntry } from './SessionSelect.js';
import { CATEGORICAL_COLORS, projectColorMap } from './colors.js';
import { fmtInt, fmtMoney } from './format.js';
import { AXIS_PROPS, ChartTooltip, GRID_PROPS } from './charts/ChartWrapper.js';
import ExploreTab from './ExploreTab.tsx';
import ContentTab from './ContentTab.tsx';
import { useCachedFetch, prefetch, invalidateClientCache } from './useCachedFetch.js';
import type { Project, SourceId } from '@shared/types.ts';

// Git repo info as returned by server/git.ts `repoInfo()`, embedded on both the
// project list (`/api/projects`) and project detail (`/api/projects/:id`) responses.
export interface RepoInfo {
  isRepo: boolean;
  commitCount?: number;
  branch?: string | null;
}

// A session row as returned by GET /api/projects/:id (server/routes/projects.ts):
// the raw DB columns plus `liveCandidate`/`ongoing` computed server-side, with
// `file_path` stripped out before it reaches the client.
export interface ProjectSession {
  id: string;
  source: SourceId | string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  name: string | null;
  summary: string | null;
  context_tokens: number | null;
  usage: string | null; // JSON-stringified Usage (see @shared/types.ts)
  agent_active_ms: number | null;
  char_count: number | null;
  liveCandidate: boolean;
  ongoing: boolean;
}

// Anything with the name/summary/first_prompt/id fields sessionDisplayName reads —
// deliberately loose so callers with slightly different session-like shapes
// (e.g. SearchModal's search-result rows) can pass it directly.
export interface NamedSession {
  id?: string | number | null;
  name?: string | null;
  summary?: string | null;
  first_prompt?: string | null;
}

interface ToolDistRow { name: string | null; count: number; }
interface KindDistRow { kind: string; count: number; }
interface ActivityRow { day: string; count: number; }

export interface ProjectAnalytics {
  toolDist: ToolDistRow[];
  kindDist: KindDistRow[];
  activity: ActivityRow[];
  errors: number;
  commits: number;
}

export interface ProjectDetailData {
  project: Project;
  sessions: ProjectSession[];
  git: RepoInfo;
  analytics: ProjectAnalytics;
}

// Session-list scale UX (v0.2): sort + source filter + windowed rendering.
const SESSION_WINDOW = 100;
// `usage` is JSON-stringified per-model token totals (see @shared/types.ts
// Usage) — parsed once here and reused by every KPI/ranking that sums cost
// or tokens across the session list (Step 3/6 of the 5d-3 brief).
function sessionUsage(s: ProjectSession): Record<string, ModelUsageInput> | null {
  try {
    return s.usage ? (JSON.parse(s.usage) as Record<string, ModelUsageInput> | null) : null;
  } catch { return null; }
}
function sessionCost(s: ProjectSession): number {
  const usage = sessionUsage(s);
  if (!usage) return 0;
  return Object.entries(usage).reduce((sum: number, [m, u]) => sum + (costOf(m, u) ?? 0), 0);
}
function sessionDurationMs(s: ProjectSession): number {
  return s.agent_active_ms ?? (s.started_at && s.ended_at ? +new Date(s.ended_at) - +new Date(s.started_at) : 0);
}

const FRIENDLY_CALL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};

interface RangeDef {
  key: string;
  days: number | null;
  label: string;
  today?: boolean;
}
// Order matches the `.rangebar` segmented control's left-to-right layout
// (Today → 7d → 30d → 1yr → All); the underlying days/refetch logic is
// unchanged from the old <select> version, only the display order.
const RANGES: RangeDef[] = [
  { key: 'today', days: null, label: 'Today', today: true },
  { key: '7', days: 7, label: '7 Days' },
  { key: '30', days: 30, label: '30 Days' },
  { key: '365', days: 365, label: '1 Year' },
  { key: 'all', days: null, label: 'All time' },
];

// Display name for a session: user-set name → tool summary → first prompt → id.
export function sessionDisplayName(s: NamedSession): string {
  return (s.name && s.name.trim()) || (s.summary && s.summary.trim())
    || s.first_prompt || (s.id ? `Session ${String(s.id).slice(0, 8)}` : 'Session');
}

export interface ProjectDetailProps {
  id: number | string;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onOpenProject: (id: number | string) => void;
  onLiveChange?: (live: { status: 'live'; sessionId: string } | null) => void;
  // Undo payload from a session that was just deleted via the Overview
  // danger-zone flow (which navigates here immediately) — seeds the shared
  // multi-select undo toast (see src/SessionSelect.tsx) so a fat-finger
  // single-session delete is recoverable here too.
  pendingUndo?: DeletedEntry | null;
}

interface Stats {
  toolCalls: number;
  messages: number;
  userPrompts: number;
  errors: number;
  errorRate: number;
  activeDays: number;
  activeMs: number;
  totalCost: number;
  totalIn: number;
  totalOut: number;
  totalTokens: number;
  modelCount: number;
  trend: { day: string; count: number; cost: number }[];
  sources: [string, number][];
  ranking: [string, number][];
  costByModel: [string, number][];
}

// Project sub-tabs (Task 5e-4). Explore/Content are deep-linkable routes
// (`/project/:id/explore` · `/project/:id/content`, wired in App.tsx);
// Overview/Sessions have no dedicated route (both live under the bare
// `/project/:id`) and are tracked as local component state instead, so a
// project switch or a reload always lands on Overview — same as today.
type ProjectTab = 'overview' | 'explore' | 'content' | 'sessions';

export default function ProjectDetail({ id, onBack, onOpenSession, onOpenProject, onLiveChange, pendingUndo }: ProjectDetailProps) {
  const [error, setError] = useState<string | null>(null);
  const [assocPath, setAssocPath] = useState('');
  const [range, setRange] = useState('all');
  const [sortKey, setSortKey] = useState('recent');
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [listLimit, setListLimit] = useState(SESSION_WINDOW);
  // Inline rename (edit-in-place) + inline unlink confirm — never window.prompt/
  // confirm, which silently no-op in embedded/preview browsers (see CLAUDE.md).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);
  // Per-project identity color: assigned in the SAME fixed order as Home
  // (projectColorMap over all project ids), so the head/breadcrumb dot matches
  // Home's rail + ledger pill for this project.
  const { data: allProjects } = useCachedFetch<PickableProject[]>(projectsUrl());
  const projectColor = useMemo(
    () => projectColorMap((allProjects ?? []).map((p) => p.id)).get(Number(id)),
    [allProjects, id]);

  const [, navigate] = useLocation();
  const [atExploreRoute] = useRoute('/project/:id/explore');
  const [atContentRoute] = useRoute('/project/:id/content');
  const [localTab, setLocalTab] = useState<'overview' | 'sessions'>('overview');
  const tab: ProjectTab = atExploreRoute ? 'explore' : atContentRoute ? 'content' : localTab;
  function selectTab(next: ProjectTab) {
    if (next === 'explore') { navigate(`/project/${id}/explore`); return; }
    if (next === 'content') { navigate(`/project/${id}/content`); return; }
    if (tab === 'explore' || tab === 'content') navigate(`/project/${id}`);
    setLocalTab(next);
  }

  // "Today" = fractional days since local midnight, computed once per range change
  // (a stable value avoids a Date.now()-driven refetch loop).
  const days = useMemo(() => {
    const def = RANGES.find((r) => r.key === range);
    if (def?.today) { const d = new Date(); d.setHours(0, 0, 0, 0); return (Date.now() - d.getTime()) / 86400000; }
    return def?.days ?? null;
  }, [range]);
  // `days` is `number | null` (null = no range limit); projectUrl's `days`
  // param is `number | string | undefined` — null and undefined mean the same
  // thing here (omit the query param), so convert honestly at the call site.
  // The URL doubles as the SWR cache key (Task 5): re-landing on this exact
  // id+range combo (tab switch, breadcrumb back-nav) renders the last-seen
  // data immediately instead of a blank page, then refreshes in place.
  // `loadError` is the hook's fetch-failure signal — only rendered as a hard
  // error banner below when `data` is still null (a true cold-load failure,
  // e.g. a deleted project's 404): a background revalidation failure on an
  // already-populated pane must not blank/replace working data.
  const { data, error: loadError, refresh } = useCachedFetch<ProjectDetailData>(projectUrl(id, days ?? undefined));

  // Project-level LIVE pill: light up when any session log is being written right now.
  useEffect(() => {
    const live = data?.sessions?.find((s) => s.liveCandidate);
    onLiveChange?.(live ? { status: 'live', sessionId: live.id } : null);
    return () => onLiveChange?.(null);
  }, [data]);

  function startRename() {
    if (!data) return;
    setNameErr(null);
    setNameDraft(data.project.name);
    setRenaming(true);
  }
  async function saveRename() {
    if (savingName) return;
    const name = nameDraft.trim();
    if (!name) { setRenaming(false); return; } // blank cancels (folder name required)
    setNameErr(null);
    setSavingName(true);
    // catch → inline error (mirrors HomePage): without it a rejected rename is
    // a silently-dropped unhandled promise rejection.
    try {
      await api.renameProject(id, name);
      // The renamed name is now stale everywhere it's cached client-side
      // (ProjectPicker's list, this project's own detail payload, etc.) —
      // drop the whole SWR cache so the next read of any of those URLs goes
      // back to the server instead of replaying the old name for the rest
      // of the session.
      invalidateClientCache();
      setRenaming(false);
      refresh();
    }
    catch (e) { setNameErr(String((e as Error).message)); }
    finally { setSavingName(false); }
  }

  async function associate(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/projects/${id}/associate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: assocPath }) });
    const body = await r.json();
    if (!r.ok) return setError(body.error);
    invalidateClientCache(); // project may have merged/moved — every cached list/detail is now suspect
    onBack(); // project may have merged into another — go back to the list
  }

  async function unlink(source: string) {
    await fetch(`/api/projects/${id}/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    invalidateClientCache(); // unlinking spins off a new project — the cached project list is stale
    setConfirmUnlink(null);
    refresh();
  }

  const stats: Stats | null = useMemo(() => {
    if (!data) return null;
    const { sessions, analytics } = data;
    const toolCalls = analytics.kindDist.find((k) => k.kind === 'tool_use')?.count || 0;
    const messages = analytics.kindDist.reduce((s, k) => s + k.count, 0);
    const userPrompts = analytics.kindDist.find((k) => k.kind === 'user')?.count || 0;
    // Agent active total: same per-session fallback as the "duration" sort
    // (agent_active_ms when present, else wall-clock start→end).
    const activeMs = sessions.reduce((sum, s) => sum + sessionDurationMs(s), 0);
    // Cost/tokens: sum per-model usage across every session in range (Step 3 —
    // client-side aggregation, same source data the session list already
    // parses via sessionUsage/sessionCost).
    let totalCost = 0, totalIn = 0, totalOut = 0;
    const byModel = new Map<string, number>();
    const modelsSeen = new Set<string>();
    for (const s of sessions) {
      const usage = sessionUsage(s);
      if (!usage) continue;
      for (const [m, u] of Object.entries(usage)) {
        modelsSeen.add(m);
        totalIn += u.input || 0;
        totalOut += u.output || 0;
        const cost = costOf(m, u) ?? 0;
        totalCost += cost;
        byModel.set(m, (byModel.get(m) || 0) + cost);
      }
    }
    const costByModel = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    // Trend: sessions + cost per day, gaps filled so the chart line/bars are
    // continuous across the whole range.
    const byDay = new Map<string, number>();
    const costByDay = new Map<string, number>();
    for (const s of sessions) {
      if (!s.started_at) continue;
      const day = s.started_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      costByDay.set(day, (costByDay.get(day) || 0) + sessionCost(s));
    }
    const dayKeys = [...byDay.keys()].sort();
    const trend: { day: string; count: number; cost: number }[] = [];
    if (dayKeys.length) {
      const start = days ? new Date(Date.now() - days * 86400000) : new Date(dayKeys[0]);
      for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        trend.push({ day: key, count: byDay.get(key) || 0, cost: costByDay.get(key) || 0 });
      }
    }
    // Source donut
    const bySource = new Map<string, number>();
    for (const s of sessions) bySource.set(s.source, (bySource.get(s.source) || 0) + 1);
    const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
    // Call ranking with friendly names merged
    const ranked = new Map<string, number>();
    for (const d of analytics.toolDist) {
      const name = d.name || '';
      const label = FRIENDLY_CALL[name] || (name.length > 18 ? 'Other' : name);
      ranked.set(label, (ranked.get(label) || 0) + d.count);
    }
    if (userPrompts) ranked.set('User Prompt', userPrompts);
    const ranking = [...ranked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      toolCalls, messages, userPrompts,
      errors: analytics.errors || 0,
      errorRate: toolCalls ? ((analytics.errors || 0) / toolCalls) * 100 : 0,
      activeDays: new Set(sessions.filter((s) => s.started_at).map((s) => (s.started_at as string).slice(0, 10))).size,
      activeMs, totalCost, totalIn, totalOut, totalTokens: totalIn + totalOut, modelCount: modelsSeen.size,
      trend, sources, ranking, costByModel,
    };
  }, [data, days]);

  // Sorted + filtered view of the session list; rendering is windowed
  // (SESSION_WINDOW rows + "Show more") so 1000-session projects stay snappy.
  const sortedSessions = useMemo(() => {
    let list = data?.sessions ?? [];
    if (sourceFilter) list = list.filter((s) => s.source === sourceFilter);
    const by: Record<string, (a: ProjectSession, b: ProjectSession) => number> = {
      recent: (a, b) => (b.started_at || '').localeCompare(a.started_at || ''),
      cost: (a, b) => sessionCost(b) - sessionCost(a),
      duration: (a, b) => sessionDurationMs(b) - sessionDurationMs(a),
      messages: (a, b) => (b.message_count || 0) - (a.message_count || 0),
    };
    return [...list].sort(by[sortKey]);
  }, [data, sortKey, sourceFilter]);

  // Overview teaser: the 5 most-recent sessions, independent of the Sessions
  // tab's sort/source filters (those live only under `tab==='sessions'`).
  const recent5 = useMemo(
    () => [...(data?.sessions ?? [])]
      .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
      .slice(0, 5),
    [data]);

  // Session-level multi-select delete — the same shared component/behavior as
  // the Home recent-sessions stream (see src/SessionSelect.tsx).
  const selectableSessions = useMemo(
    () => (data?.sessions ?? []).map((s) => ({ id: s.id, source: String(s.source), project_id: Number(id) })),
    [data, id]);
  const sessionSelect = useSessionSelect(selectableSessions, refresh, pendingUndo);

  if (error) return <div className="page center error-banner">{error}</div>;
  // A true cold-load failure (no data has ever rendered for this hook
  // instance — e.g. a deleted project's 404) surfaces the hook's error
  // instead of sticking on "Loading…" forever. Once `data` exists, a later
  // background-refresh failure is deliberately NOT shown here — see
  // `loadError`'s definition above.
  if (loadError && !data) return <div className="page center error-banner">{loadError}</div>;
  if (!data || !stats) return <div className="page center muted">Loading…</div>;
  const { project, sessions, git } = data;
  const liveSession = sessions.find((s) => s.liveCandidate);
  const maxRank = Math.max(1, ...stats.ranking.map(([, n]) => n));
  const maxCostByModel = Math.max(0.01, ...stats.costByModel.map(([, n]) => n));

  return (
    <div className="page project-detail">
      <div className="crumbs">
        <ProjectPicker current={project} color={projectColor} onPick={onOpenProject} />
        <span className="crumb-sep">›</span>
        <SessionPicker sessions={sessions} current={null} onPick={onOpenSession} prefetchUrl={projectUrl(id, days ?? undefined)} />
        <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onBack}>← {t('Projects')}</button>
      </div>

      <div className="project-head">
        {renaming ? (
          <>
            <input className="ov-name-input" autoFocus value={nameDraft} disabled={savingName}
              placeholder={project.name}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(false); }} />
            <button className="btn tiny primary" disabled={savingName} onMouseDown={(e) => e.preventDefault()} onClick={saveRename}>✓</button>
            <button className="btn tiny ghost" disabled={savingName} onMouseDown={(e) => e.preventDefault()} onClick={() => setRenaming(false)}>✕</button>
            {nameErr && <span className="menu-err small">{nameErr}</span>}
          </>
        ) : (
          <>
            <h2><span className="pdot" style={{ '--project-color': projectColor } as React.CSSProperties} />{project.name}</h2>
            <button className="btn tiny ghost" title={t('Rename project')} onClick={startRename}>✎</button>
          </>
        )}
        <span className="muted">{project.path}</span>
        {git.isRepo
          ? <span className="pill git-pill">⎇ {git.branch}</span>
          : <span className="pill warn-pill">No Git repo — time travel unavailable</span>}
        {[...new Set(sessions.map((s) => s.source))].length > 1 &&
          [...new Set(sessions.map((s) => s.source))].map((src) => (
            <button key={src} className="btn tiny ghost" title={`Unlink ${src} into its own project`}
              onClick={() => setConfirmUnlink(src)}>⛓✕ {src}</button>
          ))}
        <div className="rangebar" style={{ marginLeft: 'auto' }} title={t('Time range')}>
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>{t(r.label)}</button>
          ))}
        </div>
      </div>

      {confirmUnlink && (
        <div className="inline-confirm">
          <span className="muted small">{confirmUnlink} — {t('Unlink into its own project?')}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn tiny ghost" onClick={() => setConfirmUnlink(null)}>{t('Cancel')}</button>
            <button className="btn tiny danger-btn" onClick={() => unlink(confirmUnlink)}>⛓✕ {t('Unlink')}</button>
          </div>
        </div>
      )}

      {project.path.includes('#') && (
        <form className="error-banner" style={{ display: 'flex', gap: 8, alignItems: 'center', borderColor: 'var(--warn)', color: 'var(--warn)' }}
          onSubmit={associate}>
          <span>Needs association — this source doesn't report a real project path. Point it at the code folder:</span>
          <input className="search" style={{ flex: 1 }} placeholder="/path/to/project" value={assocPath}
            onChange={(e) => setAssocPath(e.target.value)} />
          <button className="btn small primary" type="submit" disabled={!assocPath}>Associate</button>
        </form>
      )}

      {/* ---- 5e-4: project sub-tabs — reuses .tabs/.tab from 5e-1, not redefined ---- */}
      <div className="ctlrow">
        <div className="tabs">
          <button type="button" className={`tab ${tab === 'overview' ? 'on' : ''}`} onClick={() => selectTab('overview')}>{t('Overview')}</button>
          <button type="button" className={`tab ${tab === 'explore' ? 'on' : ''}`} onClick={() => selectTab('explore')}>{t('Explore')}</button>
          <button type="button" className={`tab ${tab === 'content' ? 'on' : ''}`} onClick={() => selectTab('content')}>{t('Content')}</button>
          <button type="button" className={`tab ${tab === 'sessions' ? 'on' : ''}`} onClick={() => selectTab('sessions')}>{t('Sessions')}</button>
        </div>
      </div>

      {tab === 'explore' && <ExploreTab scope={{ type: 'project', id }} days={days} />}
      {tab === 'content' && <ContentTab scope={{ type: 'project', id }} days={days} />}

      {tab === 'overview' && <><div className="kpis">
        <div className="kpi">
          <div className="l">{t('Sessions')}</div>
          <div className="v">{fmtInt(sessions.length)}</div>
          <div className="s">{fmtInt(stats.activeDays)} {t('Active Days')}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Cost')}</div>
          <div className="v">{fmtMoney(stats.totalCost, 0)}</div>
          <div className="s">{fmtInt(stats.modelCount)} {t('models')}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Tokens')}</div>
          <div className="v">{fmtTok(stats.totalTokens)}</div>
          <div className="s">{t('Input')} {fmtTok(stats.totalIn)} · {t('Output')} {fmtTok(stats.totalOut)}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Agent Active')}</div>
          <div className="v">{fmtDur(stats.activeMs)}</div>
          <div className="s">{fmtDur(sessions.length ? stats.activeMs / sessions.length : 0)} {t('avg/session')}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Messages')}</div>
          <div className="v">{fmtInt(stats.messages)}</div>
          <div className="s">{fmtInt(stats.userPrompts)} {t('prompts')}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Tool Calls')}</div>
          <div className="v">{fmtInt(stats.toolCalls)}</div>
          <div className="s">{fmtInt(sessions.length ? Math.round(stats.toolCalls / sessions.length) : 0)} {t('avg/session')}</div>
        </div>
        <div className={`kpi ${stats.errors ? 'warn' : ''}`}>
          <div className="l">{t('Errors')}</div>
          <div className="v">{fmtInt(stats.errors)}</div>
          <div className="s">{stats.errorRate.toFixed(1)}% {t('Error Rate')}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Commits')}</div>
          <div className="v">{fmtInt(data.analytics.commits)}</div>
          <div className="s">{t('in range')}</div>
        </div>
      </div>

      <div className="card trend-card">
        <h3>{t('Daily cost & sessions')}</h3>
        {stats.trend.length ? (
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={stats.trend} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="day" {...AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis yAxisId="cost" {...AXIS_PROPS} tickFormatter={(v: number) => fmtMoney(v, 0)} />
              <YAxis yAxisId="sessions" orientation="right" {...AXIS_PROPS} allowDecimals={false} />
              {/* Bar (cost, $) and Line (session count) share one tooltip but different
                  units — ChartTooltip's formatValue gets a single value with no series
                  context, so this heuristic formats non-integer values (cost) as `$`
                  and integers (a session count is always whole) as a plain number.
                  hideTotal suppresses the shared "Total" row: summing a $ value and a
                  session count (e.g. $3.50 + 2 sessions = "$5.50") is meaningless —
                  each per-row value is still correct and shown, just not their sum.
                  Recharts' <Tooltip> content callback is typed as the library's own
                  (non-generic) `TooltipContentProps<ValueType, NameType>`; our chart
                  data is always numeric, so the cast to ChartTooltip's narrower
                  `<V extends number>` prop type reflects the real runtime shape. */}
              <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} hideTotal formatValue={(v: number) => (Number.isInteger(v) ? String(v) : fmtMoney(v, 2))} />} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
              <Bar yAxisId="cost" dataKey="cost" name={t('Cost')} fill={CATEGORICAL_COLORS[0]} radius={[3, 3, 0, 0]} />
              <Line yAxisId="sessions" type="monotone" dataKey="count" name={t('Sessions')} stroke={CATEGORICAL_COLORS[1]} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="muted small pad8">{t('No activity in this time range.')}</div>
        )}
      </div>

      <div className="pd-charts">
        <div className="card">
          <h3>{t('Source mix')}</h3>
          {stats.sources.length ? (
            <div className="donut-wrap" style={{ marginTop: 10 }}>
              {/* Reflows with the card: ResponsiveContainer (fixed height, width
                  100%) inside a bounded flex column, so the donut recomputes on
                  card resize instead of clipping at a fixed 140px (PROJ-10). */}
              <div style={{ flex: '1 1 140px', minWidth: 130, maxWidth: 180 }}>
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie data={stats.sources.map(([name, value]) => ({ name, value }))} dataKey="value" nameKey="name"
                      innerRadius={38} outerRadius={64} paddingAngle={stats.sources.length > 1 ? 2 : 0} stroke="none">
                      {stats.sources.map((_, i) => <Cell key={i} fill={CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]} />)}
                    </Pie>
                    {/* No hideTotal here: a Pie hover always yields a single-slice payload
                        (one row), so ChartTooltip's `rows.length > 1` Total guard already
                        never fires — there's no mixed-unit sum to suppress. */}
                    <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div>
                {stats.sources.map(([src, n], i) => (
                  <div key={src} className="donut-legend-row">
                    <span className="donut-dot" style={{ background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} />
                    <span>{src}</span>
                    <span className="muted">{Math.round((n / Math.max(1, sessions.length)) * 100)}%</span>
                  </div>
                ))}
                <div className="muted small" style={{ marginTop: 6 }}>{t('Total')} {fmtInt(sessions.length)} {t('sessions')}</div>
              </div>
            </div>
          ) : (
            <div className="muted small pad8">{t('No activity in this time range.')}</div>
          )}
        </div>
        <div className="card">
          <h3>{t('Call Ranking')}</h3>
          <div style={{ marginTop: 10 }}>
            {stats.ranking.map(([label, n], i) => (
              <div key={label} className="hbar">
                <span className="n">{label}</span>
                <div className="track"><div className="fill" style={{ width: `${(n / maxRank) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{fmtInt(n)}</span>
              </div>
            ))}
            {!stats.ranking.length && <div className="muted small">{t('No tool calls recorded.')}</div>}
          </div>
        </div>
        <div className="card">
          <h3>{t('Cost by model')}</h3>
          <div style={{ marginTop: 10 }}>
            {stats.costByModel.map(([model, cost], i) => (
              <div key={model} className="hbar">
                <span className="n">{model}</span>
                <div className="track"><div className="fill" style={{ width: `${(cost / maxCostByModel) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{fmtMoney(cost, 2)}</span>
              </div>
            ))}
            {!stats.costByModel.length && <div className="muted small">{t('No cost data recorded.')}</div>}
          </div>
        </div>
      </div>

      {/* Overview teaser: the 5 most-recent sessions + a jump to the full list
          (which lives ONLY under the Sessions tab — PROJ-06). */}
      <div className="session-head">
        <h3 className="page-title">{t('Recent sessions')}</h3>
        {liveSession && (
          <span className="pill live-pill live clickable" title={t('Open the live session')}
            onClick={() => onOpenSession(liveSession.id)}>● LIVE</span>
        )}
        {sessions.length > 0 && (
          <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => selectTab('sessions')}>
            {t('View all')} {fmtInt(sessions.length)} →
          </button>
        )}
      </div>
      <div className="session-list">
        {recent5.map((s) => (
          <div key={s.id} className="card session-row" onClick={() => onOpenSession(s.id)}>
            <div className="session-prompt">{sessionDisplayName(s)}</div>
            <div className="session-meta muted small">
              {s.liveCandidate && <span className="pill live-pill live">● LIVE</span>}
              <span className="pill src-pill">{s.source}</span>
              <span>{fmtInt(s.message_count)} messages</span>
              {s.started_at && <span>{new Date(s.started_at).toLocaleString()}</span>}
            </div>
          </div>
        ))}
        {!recent5.length && <div className="muted small pad8">{t('No sessions in this time range.')}</div>}
      </div></>}
      {tab === 'sessions' && <>
      <div className="session-head">
        <h3 className="page-title">{t('Sessions')}</h3>
        {liveSession && (
          <span className="pill live-pill live clickable" title={t('Open the live session')}
            onClick={() => onOpenSession(liveSession.id)}>● LIVE</span>
        )}
        <div className="filter-chips" style={{ marginLeft: 'auto' }}>
          {[...new Set(sessions.map((s) => s.source))].length > 1 &&
            [...new Set(sessions.map((s) => s.source))].map((src) => (
              <button key={src} className={`chip ${sourceFilter === src ? 'on' : ''}`}
                onClick={() => setSourceFilter(sourceFilter === src ? null : src)}>{src}</button>
            ))}
          <select className="chip" value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
            <option value="recent">{t('Recent')}</option>
            <option value="cost">{t('Cost')}</option>
            <option value="duration">{t('Duration')}</option>
            <option value="messages">{t('Messages')}</option>
          </select>
          {sessionSelect.Bar}
        </div>
      </div>
      <div className="session-list">
        {sortedSessions.slice(0, listLimit).map((s) => {
          const isSel = sessionSelect.isSelected(s.id);
          return (
            <div key={s.id} className={`card session-row ${sessionSelect.selectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''}`}
              onClick={() => (sessionSelect.selectMode ? sessionSelect.toggle(s.id) : onOpenSession(s.id))}>
              <div className="session-prompt">
                {sessionSelect.selectMode && <span className={`sel-check ${isSel ? 'on' : ''}`}>{isSel ? '☑' : '☐'}</span>}
                {sessionDisplayName(s)}
              </div>
              {s.first_prompt && sessionDisplayName(s) !== s.first_prompt && (
                <div className="session-subprompt muted small">{s.first_prompt}</div>
              )}
              <div className="session-meta muted small">
                {s.liveCandidate && <span className="pill live-pill live">● LIVE</span>}
                {!s.liveCandidate && s.ongoing && (
                  <span className="pill ongoing-pill" title={t('The source log was written to in the last 10 minutes — stats are “so far”, auto-sync keeps this fresh')}>◔ {t('ongoing')}</span>
                )}
                <span className="pill src-pill">{s.source}</span>
                <span>{fmtInt(s.message_count)} messages</span>
                {s.context_tokens && s.context_tokens > 0 ? (
                  <span title={t('Context window size at the last message (real usage from the session log)')}>⧉ {fmtTok(s.context_tokens)} ctx</span>
                ) : s.char_count && s.char_count > 0 && (
                  <span title={t('Estimated content size (~4 characters per token) — re-import for real context usage')}>⧉ ~{fmtTokens(s.char_count)} tokens</span>
                )}
                {s.started_at && <span>{new Date(s.started_at).toLocaleString()}</span>}
                {s.started_at && s.ended_at && <span>{duration(s.started_at, s.ended_at)}</span>}
              </div>
            </div>
          );
        })}
        {sortedSessions.length > listLimit && (
          <button className="btn small window-btn" onClick={() => setListLimit((n) => n + SESSION_WINDOW)}>
            ↓ {fmtInt(sortedSessions.length - listLimit)} more sessions
          </button>
        )}
        {!sortedSessions.length && <div className="muted small pad8">{t('No sessions in this time range.')}</div>}
      </div>
      </>}
      {sessionSelect.Toast}
    </div>
  );
}

// Minimal project shape the picker needs (a subset of Project, plus the
// aggregate columns GET /api/projects adds server-side).
export interface PickableProject {
  id: number | string;
  name: string;
  path?: string;
  session_count?: number;
  last_active?: string | null;
}

export interface ProjectPickerProps {
  current: PickableProject | null | undefined;
  onPick: (id: number | string) => void;
  // Identity color for the current project (from projectColorMap over all ids),
  // rendered as a `.pdot` on the trigger so the breadcrumb matches Home + head.
  color?: string;
}

// Project dropdown: switch projects from the breadcrumb, mirroring the session
// picker. Lazily loads the project list on first open.
export function ProjectPicker({ current, onPick, color }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Task 5: SWR-cached list, keyed on the same '/api/projects' URL the hover
  // prefetch below warms — so by the time this popover opens the data is
  // usually already resolved (no "Loading…" flash).
  const { data: projects } = useCachedFetch<PickableProject[]>(projectsUrl());
  const list = (projects || []).filter((p) => !q
    || p.name.toLowerCase().includes(q.toLowerCase()) || (p.path || '').toLowerCase().includes(q.toLowerCase()));
  // Per-item identity dots, same fixed order as Home's rail/ledger.
  const itemColors = useMemo(() => projectColorMap((projects ?? []).map((p) => p.id)), [projects]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="crumb on" onMouseEnter={() => prefetch(projectsUrl())}>
          {current
            ? <span className="pdot" style={{ '--project-color': color } as React.CSSProperties} />
            : '◫ '}
          {current?.name || t('Projects')} <span className="muted">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu-pop picker-pop" align="start" sideOffset={6}>
          <input autoFocus className="search picker-search" placeholder={t('Search projects or sessions')}
            value={q} onChange={(e) => setQ(e.target.value)} />
          {projects === null && <div className="muted small pad8">{t('Loading…')}</div>}
          {list.map((p) => (
            <button key={p.id} className="menu-item picker-item"
              onClick={() => { setOpen(false); if (p.id !== current?.id) onPick?.(p.id); }}>
              <span className="picker-check">{p.id === current?.id ? '✓' : ''}</span>
              <span className="picker-body">
                <span className="picker-title">
                  <span className="pdot" style={{ '--project-color': itemColors.get(Number(p.id)) } as React.CSSProperties} />{p.name}
                </span>
                <span className="muted small">
                  {p.session_count} {t('sessions')}
                  {p.last_active && ` · ${ago(p.last_active)}`}
                </span>
              </span>
            </button>
          ))}
          {projects && !list.length && <div className="muted small pad8">{t('No projects match.')}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Minimal session shape the picker needs.
export interface PickableSession extends NamedSession {
  id: string;
  message_count?: number;
  started_at?: string | null;
}

export interface SessionPickerProps {
  sessions: PickableSession[] | null | undefined;
  current: PickableSession | null | undefined;
  onPick: (id: string) => void;
  loading?: boolean;
  // URL that supplies this picker's `sessions` prop in the caller's context
  // (there's no dedicated session-list endpoint — sessions arrive embedded in
  // GET /api/projects/:id) — hover-prefetched into the shared SWR cache so
  // navigating there next (or back to it) renders instantly. Optional: not
  // every mounting context has one to offer (e.g. SessionView's own picker,
  // out of scope for Task 5).
  prefetchUrl?: string;
}

// Session dropdown: shows on both project and session pages.
export function SessionPicker({ sessions, current, onPick, loading, prefetchUrl }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const title = (s: PickableSession) => sessionDisplayName(s).slice(0, 48);
  const list = (sessions || []).filter((s) => !q || title(s).toLowerCase().includes(q.toLowerCase()) || String(s.id).includes(q));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={`crumb ${current ? 'on' : ''}`} onMouseEnter={() => prefetchUrl && prefetch(prefetchUrl)}>
          ▤ {current ? title(current) : t('Select session')} <span className="muted">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu-pop picker-pop" align="start" sideOffset={6}>
          <input autoFocus className="search picker-search" placeholder={t('Search Sessions')}
            value={q} onChange={(e) => setQ(e.target.value)} />
          {loading && <div className="muted small pad8">{t('Loading…')}</div>}
          {list.map((s) => (
            <button key={s.id} className="menu-item picker-item" onClick={() => { setOpen(false); onPick(s.id); }}>
              <span className="picker-check">{current?.id === s.id ? '✓' : ''}</span>
              <span className="picker-body">
                <span className="picker-title">{title(s)}</span>
                <span className="muted small">{s.message_count} messages · {s.started_at ? ago(s.started_at) : ''}</span>
              </span>
            </button>
          ))}
          {!loading && !list.length && <div className="muted small pad8">{t('No sessions match.')}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ago(ts: string): string {
  const d = Math.round((Date.now() - +new Date(ts)) / 86400000);
  return d === 0 ? t('today') : d === 1 ? t('1 day ago') : `${d} ${t('days ago')}`;
}

function fmtDur(ms: number): string {
  if (!ms) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function duration(a: string, b: string): string {
  const ms = +new Date(b) - +new Date(a);
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

// Rough content size: ~4 characters per token.
function fmtTokens(chars: number): string {
  return fmtTok(Math.round(chars / 4));
}
