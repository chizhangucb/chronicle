import React, { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import ImportWizard from './ImportWizard.jsx';
import ProjectDetail from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import HubPage from './HubPage.jsx';
import { t, lang, setLang } from './i18n.js';
import SkillsPage from './SkillsPage.jsx';
import SecurityPage from './SecurityPage.jsx';

const SOURCE_ICONS = { 'claude-code': '✳', codex: '⬡', cursor: '▮', 'gemini-cli': '✦' };

export default function App() {
  // view: {name:'home'} | {name:'project', id} | {name:'session', id, projectId}
  const [view, setView] = useState({ name: 'home' });
  const [projects, setProjects] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // {status: 'live'|'reconnecting'|'stopped', sessionId?} — reported by the
  // session/project views so the pill stays visible anywhere in the project.
  const [liveInfo, setLiveInfo] = useState(null);

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (view.name === 'home') refresh(); }, [view.name, refresh]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => setView({ name: 'home' })}>
          <span className="brand-mark">◷</span> Chronicle
          <span className="brand-sub">{t('AI Session Time Machine')}</span>
        </div>
        <nav className="topnav">
          <button className={`chip ${view.name === 'home' || view.name === 'project' || view.name === 'session' ? 'on' : ''}`}
            onClick={() => setView({ name: 'home' })}>◷ {t('Projects')}</button>
          <button className={`chip ${view.name === 'hub' ? 'on' : ''}`} onClick={() => setView({ name: 'hub' })}>⬢ {t('MCP Hub')}</button>
          <button className={`chip ${view.name === 'skills' ? 'on' : ''}`} onClick={() => setView({ name: 'skills' })}>✦ {t('Skills')}</button>
          <button className={`chip ${view.name === 'security' ? 'on' : ''}`} onClick={() => setView({ name: 'security' })}>🛡 {t('Security')}</button>
        </nav>
        <div className="topbar-right">
          {liveInfo && (view.name === 'session' || view.name === 'project') && (
            <span className={`pill live-pill ${liveInfo.status}`}
              title={liveInfo.sessionId && view.name !== 'session' ? 'Open the live session' : 'Live streaming from the session log'}
              style={liveInfo.sessionId && view.name !== 'session' ? { cursor: 'pointer' } : undefined}
              onClick={() => {
                if (liveInfo.sessionId && view.name === 'project') {
                  setView({ name: 'session', id: liveInfo.sessionId, projectId: view.id });
                }
              }}>
              {liveInfo.status === 'live' ? '● LIVE' : liveInfo.status === 'reconnecting' ? '◌ Reconnecting…' : '○ Stopped'}
            </span>
          )}
          {view.name === 'home' && (
            <button className="btn primary" onClick={() => setWizardOpen(true)}>{t('+ Import Sessions')}</button>
          )}
          <select className="chip lang-select" title="Language / 语言" value={lang()}
            onChange={(e) => setLang(e.target.value)}>
            <option value="en">EN</option>
            <option value="zh">中文</option>
          </select>
        </div>
      </header>

      {view.name === 'home' && (
        <HomePage projects={projects} onOpenProject={(id) => setView({ name: 'project', id })}
          onImport={() => setWizardOpen(true)} onRefresh={refresh} />
      )}
      {view.name === 'project' && (
        <ProjectDetail id={view.id}
          onBack={() => setView({ name: 'home' })}
          onLiveChange={setLiveInfo}
          onOpenSession={(sid) => setView({ name: 'session', id: sid, projectId: view.id })} />
      )}
      {view.name === 'session' && (
        <SessionView sessionId={view.id}
          onLiveChange={setLiveInfo}
          onBack={() => setView({ name: 'project', id: view.projectId })} />
      )}
      {view.name === 'hub' && <HubPage />}
      {view.name === 'skills' && <SkillsPage />}
      {view.name === 'security' && <SecurityPage />}

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onImported={() => { refresh(); }} />
      )}
    </div>
  );
}

function ProjectMenu({ project, onOpenProject, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function run(action) {
    setOpen(false);
    try {
      if (action === 'sync') {
        setSyncing(true);
        await api.syncProject(project.id);
        onRefresh();
      } else if (action === 'details') {
        onOpenProject(project.id);
      } else if (action === 'rename') {
        const name = prompt(t('New display name (folder is not touched):'), project.name);
        if (!name) return;
        await api.renameProject(project.id, name);
        onRefresh();
      } else if (action === 'remove') {
        if (!confirm(`${t('Remove')} "${project.name}" ${t('from Chronicle? Your source logs and project folder are not touched.')}`)) return;
        await api.deleteProject(project.id);
        onRefresh();
      }
    } catch (e) {
      alert(String(e.message));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <span className="project-menu" onClick={(e) => e.stopPropagation()}>
      <button className={`btn tiny ghost gear ${syncing ? 'spin' : ''}`} title={t('Project options')}
        onClick={() => setOpen((o) => !o)}>{syncing ? '◌' : '⚙'}</button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop">
            <button className="menu-item" onClick={() => run('sync')}>⟳ {t('Sync Update')}</button>
            <button className="menu-item" onClick={() => run('details')}>ⓘ {t('View Details')}</button>
            <button className="menu-item" onClick={() => run('rename')}>✎ {t('Rename')}</button>
            <div className="menu-sep" />
            <button className="menu-item danger" onClick={() => run('remove')}>
              🗑 {t('Remove from Chronicle')}
              <span className="muted small">{t("(won't delete source project)")}</span>
            </button>
          </div>
        </>
      )}
    </span>
  );
}

function HomePage({ projects, onOpenProject, onImport, onRefresh }) {
  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) {
    return (
      <div className="page center empty-state">
        <div className="empty-icon">◷</div>
        <h2>{t('Welcome to Chronicle')}</h2>
        <p className="muted">Import your AI coding sessions and time-travel through how your code came to be.<br />
          Everything stays on this machine — local-first, offline, read-only on your logs.</p>
        <button className="btn primary lg" onClick={onImport}>{t('Import your first project')}</button>
      </div>
    );
  }
  return (
    <div className="page">
      <h2 className="page-title">{t('Projects')} <span className="muted">({projects.length})</span></h2>
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => onOpenProject(p.id)}>
            <div className="project-card-head">
              <span className="project-name">{p.name}</span>
              <span className="project-card-actions">
                {p.git?.isRepo && <span className="pill git-pill" title={`${p.git.commitCount} commits`}>⎇ {p.git.branch}</span>}
                <ProjectMenu project={p} onOpenProject={onOpenProject} onRefresh={onRefresh} />
              </span>
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
