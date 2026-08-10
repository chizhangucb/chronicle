import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import { costOf, type ModelUsageInput } from './models.js';
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
}

export interface ProjectDetailData {
  project: Project;
  sessions: ProjectSession[];
  git: RepoInfo;
  analytics: ProjectAnalytics;
}

// Session-list scale UX (v0.2): sort + source filter + windowed rendering.
const SESSION_WINDOW = 100;
function sessionCost(s: ProjectSession): number {
  try {
    // `usage` is JSON-stringified per-model token totals (see @shared/types.ts
    // Usage) — cast the parse result to its declared shape at this boundary.
    const usage = s.usage ? (JSON.parse(s.usage) as Record<string, ModelUsageInput> | null) : null;
    if (!usage) return 0;
    return Object.entries(usage).reduce((sum: number, [m, u]) => sum + (costOf(m, u) ?? 0), 0);
  } catch { return 0; }
}
function sessionDurationMs(s: ProjectSession): number {
  return s.agent_active_ms ?? (s.started_at && s.ended_at ? +new Date(s.ended_at) - +new Date(s.started_at) : 0);
}

const FRIENDLY_CALL: Record<string, string> = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};
const DONUT_COLORS = ['#a78bfa', '#4f8ef7', '#34c98e', '#e5a54b', '#f472b6', '#38bdf8', '#e5684b', '#8b98a9'];

interface RangeDef {
  key: string;
  days: number | null;
  label: string;
  today?: boolean;
}
const RANGES: RangeDef[] = [
  { key: 'today', days: null, label: 'Today', today: true },
  { key: 'all', days: null, label: 'All time' },
  { key: '7', days: 7, label: '7 Days' },
  { key: '30', days: 30, label: '30 Days' },
  { key: '365', days: 365, label: '1 Year' },
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
}

interface Stats {
  totalMs: number;
  toolCalls: number;
  messages: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  activeDays: number;
  trend: { day: string; count: number }[];
  sources: [string, number][];
  ranking: [string, number][];
}

export default function ProjectDetail({ id, onBack, onOpenSession, onOpenProject, onLiveChange }: ProjectDetailProps) {
  const [data, setData] = useState<ProjectDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assocPath, setAssocPath] = useState('');
  const [range, setRange] = useState('all');
  const [sortKey, setSortKey] = useState('recent');
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [listLimit, setListLimit] = useState(SESSION_WINDOW);
  const [trendStyle, setTrendStyle] = useState<'line' | 'bar'>('line'); // line | bar

  // "Today" = fractional days since local midnight, computed once per range change
  // (a stable value avoids a Date.now()-driven refetch loop).
  const days = useMemo(() => {
    const def = RANGES.find((r) => r.key === range);
    if (def?.today) { const d = new Date(); d.setHours(0, 0, 0, 0); return (Date.now() - d.getTime()) / 86400000; }
    return def?.days ?? null;
  }, [range]);
  // `days` is `number | null` (null = no range limit); api.project's `days`
  // param is `number | string | undefined` — null and undefined mean the same
  // thing here (omit the query param), so convert honestly at the call site.
  const refresh = () => api.project(id, days ?? undefined).then(setData).catch((e: Error) => setError(String(e.message)));
  useEffect(() => { refresh(); }, [id, range]);

  // Project-level LIVE pill: light up when any session log is being written right now.
  useEffect(() => {
    const live = data?.sessions?.find((s) => s.liveCandidate);
    onLiveChange?.(live ? { status: 'live', sessionId: live.id } : null);
    return () => onLiveChange?.(null);
  }, [data]);

  async function rename() {
    if (!data) return;
    const name = prompt('New display name (folder is not touched):', data.project.name);
    if (!name) return;
    await api.renameProject(id, name);
    refresh();
  }

  async function associate(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/projects/${id}/associate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: assocPath }) });
    const body = await r.json();
    if (!r.ok) return setError(body.error);
    onBack(); // project may have merged into another — go back to the list
  }

  async function unlink(source: string) {
    if (!confirm(`Unlink ${source} sessions into their own project?`)) return;
    await fetch(`/api/projects/${id}/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    refresh();
  }

  const stats: Stats | null = useMemo(() => {
    if (!data) return null;
    const { sessions, analytics } = data;
    const durations = sessions.filter((s) => s.started_at && s.ended_at)
      .map((s) => +new Date(s.ended_at as string) - +new Date(s.started_at as string));
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const toolCalls = analytics.kindDist.find((k) => k.kind === 'tool_use')?.count || 0;
    const messages = analytics.kindDist.reduce((s, k) => s + k.count, 0);
    const userPrompts = analytics.kindDist.find((k) => k.kind === 'user')?.count || 0;
    // Trend: sessions started per day, gaps filled so the line is continuous.
    const byDay = new Map<string, number>();
    for (const s of sessions) {
      if (!s.started_at) continue;
      const day = s.started_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    const dayKeys = [...byDay.keys()].sort();
    const trend: { day: string; count: number }[] = [];
    if (dayKeys.length) {
      const start = days ? new Date(Date.now() - days * 86400000) : new Date(dayKeys[0]);
      for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        trend.push({ day: key, count: byDay.get(key) || 0 });
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
      totalMs, toolCalls, messages,
      errors: analytics.errors || 0,
      errorRate: toolCalls ? ((analytics.errors || 0) / toolCalls) * 100 : 0,
      avgMs: durations.length ? totalMs / durations.length : 0,
      activeDays: new Set(sessions.filter((s) => s.started_at).map((s) => (s.started_at as string).slice(0, 10))).size,
      trend, sources, ranking,
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

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!data || !stats) return <div className="page center muted">Loading…</div>;
  const { project, sessions, git } = data;
  const liveSession = sessions.find((s) => s.liveCandidate);
  const maxRank = Math.max(1, ...stats.ranking.map(([, n]) => n));

  return (
    <div className="page">
      <div className="crumbs">
        <ProjectPicker current={project} onPick={onOpenProject} />
        <span className="crumb-sep">›</span>
        <SessionPicker sessions={sessions} current={null} onPick={onOpenSession} />
        <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onBack}>← {t('Projects')}</button>
      </div>

      <div className="project-head">
        <h2>📊 {project.name}</h2>
        <button className="btn tiny ghost" title="Rename (display only)" onClick={rename}>✎</button>
        <span className="muted">{project.path}</span>
        {git.isRepo
          ? <span className="pill git-pill">⎇ {git.branch} · {git.commitCount} commits</span>
          : <span className="pill warn-pill">No Git repo — time travel unavailable</span>}
        {[...new Set(sessions.map((s) => s.source))].length > 1 &&
          [...new Set(sessions.map((s) => s.source))].map((src) => (
            <button key={src} className="btn tiny ghost" title={`Unlink ${src} into its own project`}
              onClick={() => unlink(src)}>⛓✕ {src}</button>
          ))}
        <span style={{ marginLeft: 'auto' }}>
          <select className="chip range-select" value={range} onChange={(e) => setRange(e.target.value)} title={t('Time range')}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>📅 {t(r.label)}</option>)}
          </select>
        </span>
      </div>
      {project.path.includes('#') && (
        <form className="error-banner" style={{ display: 'flex', gap: 8, alignItems: 'center', borderColor: 'var(--warn)', color: 'var(--warn)' }}
          onSubmit={associate}>
          <span>Needs association — this source doesn't report a real project path. Point it at the code folder:</span>
          <input className="search" style={{ flex: 1 }} placeholder="/path/to/project" value={assocPath}
            onChange={(e) => setAssocPath(e.target.value)} />
          <button className="btn small primary" type="submit" disabled={!assocPath}>Associate</button>
        </form>
      )}

      <div className="stat-grid">
        <div className="card stat"><div className="stat-num">{sessions.length}</div><div className="muted small">{t('Sessions')}</div></div>
        <div className="card stat"><div className="stat-num">{fmtDur(stats.totalMs)}</div><div className="muted small">{t('Total Duration')}</div></div>
        <div className="card stat"><div className="stat-num">{stats.activeDays}</div><div className="muted small">{t('Active Days')}</div></div>
        <div className="card stat"><div className={`stat-num ${stats.errorRate > 10 ? 'bad' : ''}`}>{stats.errorRate.toFixed(1)}%</div><div className="muted small">{t('Error Rate')}</div></div>
        <div className="card stat"><div className="stat-num">{fmtDur(stats.avgMs)}</div><div className="muted small">{t('Avg Duration')}</div></div>
        <div className="card stat"><div className="stat-num">{stats.toolCalls}</div><div className="muted small">{t('Tool Calls')}</div></div>
        <div className="card stat"><div className="stat-num">{stats.messages}</div><div className="muted small">{t('Messages')}</div></div>
        <div className="card stat"><div className={`stat-num ${stats.errors ? 'bad' : ''}`}>{stats.errors}</div><div className="muted small">{t('Errors')}</div></div>
      </div>

      <div className="card trend-card">
        <div className="trend-head">
          <strong>{t('Activity Trend')}</strong>
          <span className="filter-chips">
            <button className={`chip ${trendStyle === 'line' ? 'on' : ''}`} onClick={() => setTrendStyle('line')}>∿ {t('Line')}</button>
            <button className={`chip ${trendStyle === 'bar' ? 'on' : ''}`} onClick={() => setTrendStyle('bar')}>▮ {t('Bar')}</button>
          </span>
        </div>
        <TrendChart points={stats.trend} style={trendStyle} />
        <div className="muted small trend-legend">— {t('Sessions')}</div>
      </div>

      <div className="pd-charts">
        <div className="card">
          <strong>{t('Tool Distribution')}</strong>
          <div className="ov-donut-wrap" style={{ marginTop: 10 }}>
            <div className="ov-donut" style={{ background: donutGradient(stats.sources, sessions.length) }} />
            <div>
              {stats.sources.map(([src, n], i) => (
                <div key={src} className="donut-legend-row">
                  <span className="donut-dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span>{src}</span>
                  <span className="muted">{Math.round((n / Math.max(1, sessions.length)) * 100)}%</span>
                </div>
              ))}
              <div className="muted small" style={{ marginTop: 6 }}>{t('Total')} {sessions.length} {t('sessions')}</div>
            </div>
          </div>
        </div>
        <div className="card">
          <strong>{t('Call Ranking')}</strong>
          <div style={{ marginTop: 10 }}>
            {stats.ranking.map(([label, n]) => (
              <div key={label} className="bar-row">
                <span className="bar-label rank-label">{label}</span>
                <div className="bar"><div className="bar-fill" style={{ width: `${(n / maxRank) * 100}%` }} /></div>
                <span className="small muted">{n}</span>
              </div>
            ))}
            {!stats.ranking.length && <div className="muted small">{t('No tool calls recorded.')}</div>}
          </div>
        </div>
      </div>
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
        </div>
      </div>
      <div className="session-list">
        {sortedSessions.slice(0, listLimit).map((s) => (
          <div key={s.id} className="card session-row" onClick={() => onOpenSession(s.id)}>
            <div className="session-prompt">{sessionDisplayName(s)}</div>
            {s.first_prompt && sessionDisplayName(s) !== s.first_prompt && (
              <div className="session-subprompt muted small">{s.first_prompt}</div>
            )}
            <div className="session-meta muted small">
              {s.liveCandidate && <span className="pill live-pill live">● LIVE</span>}
              {!s.liveCandidate && s.ongoing && (
                <span className="pill ongoing-pill" title={t('The source log was written to in the last 10 minutes — stats are “so far”, auto-sync keeps this fresh')}>◔ {t('ongoing')}</span>
              )}
              <span className="pill src-pill">{s.source}</span>
              <span>{s.message_count} messages</span>
              {s.context_tokens && s.context_tokens > 0 ? (
                <span title={t('Context window size at the last message (real usage from the session log)')}>⧉ {fmtTok(s.context_tokens)} ctx</span>
              ) : s.char_count && s.char_count > 0 && (
                <span title={t('Estimated content size (~4 characters per token) — re-import for real context usage')}>⧉ ~{fmtTokens(s.char_count)} tokens</span>
              )}
              {s.started_at && <span>{new Date(s.started_at).toLocaleString()}</span>}
              {s.started_at && s.ended_at && <span>{duration(s.started_at, s.ended_at)}</span>}
            </div>
          </div>
        ))}
        {sortedSessions.length > listLimit && (
          <button className="btn small window-btn" onClick={() => setListLimit((n) => n + SESSION_WINDOW)}>
            ↓ {(sortedSessions.length - listLimit).toLocaleString()} more sessions
          </button>
        )}
        {!sortedSessions.length && <div className="muted small pad8">{t('No sessions in this time range.')}</div>}
      </div>

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
}

// Project dropdown: switch projects from the breadcrumb, mirroring the session
// picker. Lazily loads the project list on first open.
export function ProjectPicker({ current, onPick }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<PickableProject[] | null>(null);
  useEffect(() => { if (open && !projects) api.projects().then(setProjects).catch(() => setProjects([])); }, [open]);
  const list = (projects || []).filter((p) => !q
    || p.name.toLowerCase().includes(q.toLowerCase()) || (p.path || '').toLowerCase().includes(q.toLowerCase()));

  return (
    <span className="session-picker">
      <button className="crumb on" onClick={() => setOpen((o) => !o)}>
        📁 {current?.name || t('Projects')} <span className="muted">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop picker-pop">
            <input autoFocus className="search picker-search" placeholder={t('Search projects or sessions')}
              value={q} onChange={(e) => setQ(e.target.value)} />
            {projects === null && <div className="muted small pad8">{t('Loading…')}</div>}
            {list.map((p) => (
              <button key={p.id} className="menu-item picker-item"
                onClick={() => { setOpen(false); if (p.id !== current?.id) onPick?.(p.id); }}>
                <span className="picker-check">{p.id === current?.id ? '✓' : ''}</span>
                <span className="picker-body">
                  <span className="picker-title">{p.name}</span>
                  <span className="muted small">
                    {p.session_count} {t('sessions')}
                    {p.last_active && ` · ${ago(p.last_active)}`}
                  </span>
                </span>
              </button>
            ))}
            {projects && !list.length && <div className="muted small pad8">{t('No projects match.')}</div>}
          </div>
        </>
      )}
    </span>
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
}

// Session dropdown: shows on both project and session pages.
export function SessionPicker({ sessions, current, onPick, loading }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const title = (s: PickableSession) => sessionDisplayName(s).slice(0, 48);
  const list = (sessions || []).filter((s) => !q || title(s).toLowerCase().includes(q.toLowerCase()) || String(s.id).includes(q));

  return (
    <span className="session-picker">
      <button className={`crumb ${current ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}>
        💬 {current ? title(current) : t('Select session')} <span className="muted">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop picker-pop">
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
          </div>
        </>
      )}
    </span>
  );
}

function TrendChart({ points, style }: { points: { day: string; count: number }[]; style: 'line' | 'bar' }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  if (!points.length) return <div className="muted small pad8">{t('No activity in this time range.')}</div>;
  if (style === 'bar') {
    return (
      <div className="spark trend-spark">
        {points.map((p) => (
          <div key={p.day} className="spark-bar" title={`${p.day}: ${p.count}`}
            style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }} />
        ))}
      </div>
    );
  }
  const W = 640, H = 150, PAD = 6;
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`;
  return (
    <div className="trend-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(52, 201, 142, 0.35)" />
            <stop offset="100%" stopColor="rgba(52, 201, 142, 0)" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#trendFill)" />
        <polyline points={line} fill="none" stroke="var(--accent2)" strokeWidth="2" />
      </svg>
      <div className="trend-axis muted small">
        <span>{points[0].day.slice(5)}</span>
        <span>{points[Math.floor(points.length / 2)].day.slice(5)}</span>
        <span>{points[points.length - 1].day.slice(5)}</span>
      </div>
    </div>
  );
}

function donutGradient(entries: [string, number][], total: number): string {
  let acc = 0;
  const stops = entries.map(([, n], i) => {
    const from = (acc / Math.max(1, total)) * 360; acc += n;
    const to = (acc / Math.max(1, total)) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${to}deg`;
  }).join(', ');
  return `conic-gradient(${stops || 'var(--bg3) 0deg 360deg'})`;
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
