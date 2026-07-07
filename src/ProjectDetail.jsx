import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';

const FRIENDLY_CALL = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};
const DONUT_COLORS = ['#a78bfa', '#4f8ef7', '#34c98e', '#e5a54b', '#f472b6', '#38bdf8', '#e5684b', '#8b98a9'];
const RANGES = [
  { key: 'all', days: null, label: 'All time' },
  { key: '7', days: 7, label: '7 Days' },
  { key: '30', days: 30, label: '30 Days' },
  { key: '365', days: 365, label: '1 Year' },
];

export default function ProjectDetail({ id, onBack, onOpenSession, onLiveChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [assocPath, setAssocPath] = useState('');
  const [range, setRange] = useState('all');
  const [trendStyle, setTrendStyle] = useState('line'); // line | bar

  const days = RANGES.find((r) => r.key === range)?.days ?? null;
  const refresh = () => api.project(id, days).then(setData).catch((e) => setError(String(e.message)));
  useEffect(() => { refresh(); }, [id, range]);

  // Project-level LIVE pill: light up when any session log is being written right now.
  useEffect(() => {
    const live = data?.sessions?.find((s) => s.liveCandidate);
    onLiveChange?.(live ? { status: 'live', sessionId: live.id } : null);
    return () => onLiveChange?.(null);
  }, [data]);

  async function rename() {
    const name = prompt('New display name (folder is not touched):', data.project.name);
    if (!name) return;
    await api.renameProject(id, name);
    refresh();
  }

  async function associate(e) {
    e.preventDefault();
    const r = await fetch(`/api/projects/${id}/associate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: assocPath }) });
    const body = await r.json();
    if (!r.ok) return setError(body.error);
    onBack(); // project may have merged into another — go back to the list
  }

  async function unlink(source) {
    if (!confirm(`Unlink ${source} sessions into their own project?`)) return;
    await fetch(`/api/projects/${id}/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    refresh();
  }

  const stats = useMemo(() => {
    if (!data) return null;
    const { sessions, analytics } = data;
    const durations = sessions.filter((s) => s.started_at && s.ended_at)
      .map((s) => new Date(s.ended_at) - new Date(s.started_at));
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const toolCalls = analytics.kindDist.find((k) => k.kind === 'tool_use')?.count || 0;
    const messages = analytics.kindDist.reduce((s, k) => s + k.count, 0);
    const userPrompts = analytics.kindDist.find((k) => k.kind === 'user')?.count || 0;
    // Trend: sessions started per day, gaps filled so the line is continuous.
    const byDay = new Map();
    for (const s of sessions) {
      if (!s.started_at) continue;
      const day = s.started_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    const dayKeys = [...byDay.keys()].sort();
    const trend = [];
    if (dayKeys.length) {
      const start = days ? new Date(Date.now() - days * 86400000) : new Date(dayKeys[0]);
      for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        trend.push({ day: key, count: byDay.get(key) || 0 });
      }
    }
    // Source donut
    const bySource = new Map();
    for (const s of sessions) bySource.set(s.source, (bySource.get(s.source) || 0) + 1);
    const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
    // Call ranking with friendly names merged
    const ranked = new Map();
    for (const d of analytics.toolDist) {
      const label = FRIENDLY_CALL[d.name] || (d.name.length > 18 ? 'Other' : d.name);
      ranked.set(label, (ranked.get(label) || 0) + d.count);
    }
    if (userPrompts) ranked.set('User Prompt', userPrompts);
    const ranking = [...ranked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      totalMs, toolCalls, messages,
      errors: analytics.errors || 0,
      errorRate: toolCalls ? ((analytics.errors || 0) / toolCalls) * 100 : 0,
      avgMs: durations.length ? totalMs / durations.length : 0,
      activeDays: new Set(sessions.filter((s) => s.started_at).map((s) => s.started_at.slice(0, 10))).size,
      trend, sources, ranking,
    };
  }, [data, days]);

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!data || !stats) return <div className="page center muted">Loading…</div>;
  const { project, sessions, git } = data;
  const liveSession = sessions.find((s) => s.liveCandidate);
  const maxRank = Math.max(1, ...stats.ranking.map(([, n]) => n));

  return (
    <div className="page">
      <div className="crumbs">
        <button className="crumb on" onClick={() => {}}>📁 {project.name}</button>
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
      {(project.path.startsWith('gemini-project:') || project.path.includes('#')) && (
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

      <div className="session-head">
        <h3 className="page-title">{t('Sessions')}</h3>
        {liveSession && (
          <span className="pill live-pill live clickable" title={t('Open the live session')}
            onClick={() => onOpenSession(liveSession.id)}>● LIVE</span>
        )}
      </div>
      <div className="session-list">
        {sessions.map((s) => (
          <div key={s.id} className="card session-row" onClick={() => onOpenSession(s.id)}>
            <div className="session-prompt">{s.first_prompt || <span className="muted">(no prompt)</span>}</div>
            <div className="session-meta muted small">
              {s.liveCandidate && <span className="pill live-pill live">● LIVE</span>}
              <span className="pill src-pill">{s.source}</span>
              <span>{s.message_count} messages</span>
              {s.context_tokens > 0 ? (
                <span title={t('Context window size at the last message (real usage from the session log)')}>⧉ {fmtTok(s.context_tokens)} ctx</span>
              ) : s.char_count > 0 && (
                <span title={t('Estimated content size (~4 characters per token) — re-import for real context usage')}>⧉ ~{fmtTokens(s.char_count)} tokens</span>
              )}
              {s.started_at && <span>{new Date(s.started_at).toLocaleString()}</span>}
              {s.started_at && s.ended_at && <span>{duration(s.started_at, s.ended_at)}</span>}
            </div>
          </div>
        ))}
        {!sessions.length && <div className="muted small pad8">{t('No sessions in this time range.')}</div>}
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
    </div>
  );
}

// Session dropdown (Chronicle-style): shows on both project and session pages.
export function SessionPicker({ sessions, current, onPick, loading }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const title = (s) => (s.first_prompt ? s.first_prompt.slice(0, 48) : `Session ${String(s.id).slice(0, 8)}`);
  const list = (sessions || []).filter((s) => !q || title(s).toLowerCase().includes(q.toLowerCase()) || String(s.id).includes(q));

  return (
    <span className="session-picker">
      <button className={`crumb ${current ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}>
        💬 {current ? `${title(current)} (${current.message_count ?? ''})` : t('Select session')} <span className="muted">▾</span>
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

function TrendChart({ points, style }) {
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
  const x = (i) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2);
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

function donutGradient(entries, total) {
  let acc = 0;
  const stops = entries.map(([, n], i) => {
    const from = (acc / Math.max(1, total)) * 360; acc += n;
    const to = (acc / Math.max(1, total)) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${to}deg`;
  }).join(', ');
  return `conic-gradient(${stops || 'var(--bg3) 0deg 360deg'})`;
}

function ago(ts) {
  const d = Math.round((Date.now() - new Date(ts)) / 86400000);
  return d === 0 ? t('today') : d === 1 ? t('1 day ago') : `${d} ${t('days ago')}`;
}

function fmtDur(ms) {
  if (!ms) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function duration(a, b) {
  const ms = new Date(b) - new Date(a);
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

function fmtTok(tokens) {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

// Rough content size: ~4 characters per token.
function fmtTokens(chars) {
  return fmtTok(Math.round(chars / 4));
}
