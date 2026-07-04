import React, { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import ImportWizard from './ImportWizard.jsx';
import ProjectDetail from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import HubPage from './HubPage.jsx';
import SkillsPage from './SkillsPage.jsx';

const SOURCE_ICONS = { 'claude-code': '✳', codex: '⬡', cursor: '▮', 'gemini-cli': '✦' };

export default function App() {
  // view: {name:'home'} | {name:'project', id} | {name:'session', id, projectId}
  const [view, setView] = useState({ name: 'home' });
  const [projects, setProjects] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (view.name === 'home') refresh(); }, [view.name, refresh]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => setView({ name: 'home' })}>
          <span className="brand-mark">◷</span> Chronicle
          <span className="brand-sub">AI Session Time Machine</span>
        </div>
        <nav className="topnav">
          <button className={`chip ${view.name === 'home' || view.name === 'project' || view.name === 'session' ? 'on' : ''}`}
            onClick={() => setView({ name: 'home' })}>◷ Projects</button>
          <button className={`chip ${view.name === 'hub' ? 'on' : ''}`} onClick={() => setView({ name: 'hub' })}>⬢ MCP Hub</button>
          <button className={`chip ${view.name === 'skills' ? 'on' : ''}`} onClick={() => setView({ name: 'skills' })}>✦ Skills</button>
        </nav>
        {view.name === 'home' && (
          <button className="btn primary" onClick={() => setWizardOpen(true)}>+ Import Sessions</button>
        )}
      </header>

      {view.name === 'home' && (
        <HomePage projects={projects} onOpenProject={(id) => setView({ name: 'project', id })}
          onImport={() => setWizardOpen(true)} />
      )}
      {view.name === 'project' && (
        <ProjectDetail id={view.id}
          onBack={() => setView({ name: 'home' })}
          onOpenSession={(sid) => setView({ name: 'session', id: sid, projectId: view.id })} />
      )}
      {view.name === 'session' && (
        <SessionView sessionId={view.id}
          onBack={() => setView({ name: 'project', id: view.projectId })} />
      )}
      {view.name === 'hub' && <HubPage />}
      {view.name === 'skills' && <SkillsPage />}

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onImported={() => { refresh(); }} />
      )}
    </div>
  );
}

function HomePage({ projects, onOpenProject, onImport }) {
  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) {
    return (
      <div className="page center empty-state">
        <div className="empty-icon">◷</div>
        <h2>Welcome to Chronicle</h2>
        <p className="muted">Import your AI coding sessions and time-travel through how your code came to be.<br />
          Everything stays on this machine — local-first, offline, read-only on your logs.</p>
        <button className="btn primary lg" onClick={onImport}>Import your first project</button>
      </div>
    );
  }
  return (
    <div className="page">
      <h2 className="page-title">Projects <span className="muted">({projects.length})</span></h2>
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => onOpenProject(p.id)}>
            <div className="project-card-head">
              <span className="project-name">{p.name}</span>
              {p.git?.isRepo && <span className="pill git-pill" title={`${p.git.commitCount} commits`}>⎇ {p.git.branch}</span>}
            </div>
            <div className="project-path muted">{p.path}</div>
            <div className="project-stats">
              <span>{p.session_count} sessions</span>
              <span>{p.message_count} messages</span>
              {(p.sources || '').split(',').filter(Boolean).map((s) => (
                <span key={s} className="pill src-pill">{SOURCE_ICONS[s] || '•'} {s}</span>
              ))}
            </div>
            {p.last_active && <div className="muted small">Last active {new Date(p.last_active).toLocaleString()}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
