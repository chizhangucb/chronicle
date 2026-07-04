import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const KIND_LABELS = { user: 'User', assistant: 'AI', thinking: 'Thinking', tool_use: 'Tool calls', tool_result: 'Tool results' };

export default function ProjectDetail({ id, onBack, onOpenSession }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [assocPath, setAssocPath] = useState('');

  const refresh = () => api.project(id).then(setData).catch((e) => setError(String(e.message)));
  useEffect(() => { refresh(); }, [id]);

  async function rename() {
    const name = prompt('New display name (folder is not touched):', data.project.name);
    if (!name) return;
    await fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
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

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!data) return <div className="page center muted">Loading…</div>;
  const { project, sessions, git, analytics } = data;
  const maxTool = Math.max(1, ...analytics.toolDist.map((t) => t.count));
  const maxDay = Math.max(1, ...analytics.activity.map((a) => a.count));
  const totalMsgs = analytics.kindDist.reduce((s, k) => s + k.count, 0);

  return (
    <div className="page">
      <button className="btn ghost" onClick={onBack}>← Projects</button>
      <div className="project-head">
        <h2>{project.name}</h2>
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

      <div className="analytics-row">
        <div className="card stat"><div className="stat-num">{sessions.length}</div><div className="muted small">Sessions</div></div>
        <div className="card stat"><div className="stat-num">{totalMsgs}</div><div className="muted small">Messages</div></div>
        <div className="card stat"><div className="stat-num">{analytics.activity.length}</div><div className="muted small">Active days</div></div>
        <div className="card grow">
          <div className="small muted" style={{ marginBottom: 6 }}>Tool call distribution</div>
          {analytics.toolDist.slice(0, 6).map((t) => (
            <div key={t.name} className="bar-row">
              <span className="bar-label">{t.name}</span>
              <div className="bar"><div className="bar-fill" style={{ width: `${(t.count / maxTool) * 100}%` }} /></div>
              <span className="small muted">{t.count}</span>
            </div>
          ))}
          {!analytics.toolDist.length && <div className="muted small">No tool calls recorded.</div>}
        </div>
        <div className="card grow">
          <div className="small muted" style={{ marginBottom: 6 }}>Activity</div>
          <div className="spark">
            {analytics.activity.map((a) => (
              <div key={a.day} className="spark-bar" title={`${a.day}: ${a.count}`}
                style={{ height: `${Math.max(8, (a.count / maxDay) * 100)}%` }} />
            ))}
          </div>
        </div>
      </div>

      <h3 className="page-title">Sessions</h3>
      <div className="session-list">
        {sessions.map((s) => (
          <div key={s.id} className="card session-row" onClick={() => onOpenSession(s.id)}>
            <div className="session-prompt">{s.first_prompt || <span className="muted">(no prompt)</span>}</div>
            <div className="session-meta muted small">
              <span className="pill src-pill">{s.source}</span>
              <span>{s.message_count} messages</span>
              {s.started_at && <span>{new Date(s.started_at).toLocaleString()}</span>}
              {s.started_at && s.ended_at && <span>{duration(s.started_at, s.ended_at)}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function duration(a, b) {
  const ms = new Date(b) - new Date(a);
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}
