import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // {status: 'live'|'reconnecting'|'stopped', sessionId?} — reported by the
  // session/project views so the pill stays visible anywhere in the project.
  const [liveInfo, setLiveInfo] = useState(null);
  // Session mode rail config, registered by SessionView while it is mounted:
  // { modes: [{key, icon, label, title}], active, select(key), securityOpen }
  const [rail, setRail] = useState(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle-sidebar') === 'collapsed');

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (view.name === 'home') refresh(); }, [view.name, refresh]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem('chronicle-sidebar', c ? 'expanded' : 'collapsed');
      return !c;
    });
  }

  const inProjects = view.name === 'home' || view.name === 'project' || view.name === 'session';

  return (
    <div className="app">
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sb-brand" title="Chronicle" onClick={() => setView({ name: 'home' })}>
          <span className="brand-mark">◷</span>
          <span className="sb-label sb-brand-name">Chronicle</span>
        </div>

        <nav className="sb-top">
          <button className={`sb-item ${inProjects && !rail ? 'on' : ''}`} title={t('Projects')}
            onClick={() => setView({ name: 'home' })}>
            <span className="sb-icon">◷</span><span className="sb-label">{t('Projects')}</span>
          </button>
          {rail && (
            <>
              <div className="sb-sep" />
              {rail.modes.map((m) => (
                <button key={m.key} className={`sb-item mode ${rail.active === m.key && !rail.securityOpen ? 'on' : ''}`}
                  title={m.title} onClick={() => rail.select(m.key)}>
                  <span className="sb-icon">{m.icon}</span><span className="sb-label">{m.label}</span>
                </button>
              ))}
              <button className={`sb-item mode security ${rail.securityOpen ? 'on' : ''}`} title={t('Security Check')}
                onClick={() => rail.select('security-check')}>
                <span className="sb-icon">🛡</span><span className="sb-label">{t('Security Check')}</span>
              </button>
            </>
          )}
        </nav>

        <nav className="sb-bottom">
          <button className={`sb-item util ${view.name === 'hub' ? 'on' : ''}`} title={t('MCP Hub')}
            onClick={() => setView({ name: 'hub' })}>
            <span className="sb-icon">⬢</span><span className="sb-label">{t('MCP Hub')}</span>
          </button>
          <button className={`sb-item util ${view.name === 'skills' ? 'on' : ''}`} title={t('Skills')}
            onClick={() => setView({ name: 'skills' })}>
            <span className="sb-icon">✦</span><span className="sb-label">{t('Skills')}</span>
          </button>
          <button className={`sb-item util ${view.name === 'security' ? 'on' : ''}`} title={t('Security')}
            onClick={() => setView({ name: 'security' })}>
            <span className="sb-icon">🛡</span><span className="sb-label">{t('Security')}</span>
          </button>
          <button className="sb-item util" title={t('Feedback')} onClick={() => setFeedbackOpen(true)}>
            <span className="sb-icon">⊞</span><span className="sb-label">{t('Feedback')}</span>
          </button>
          <div className="sb-sep" />
          <button className="sb-item util collapse" title={collapsed ? t('Expand') : t('Collapse')}
            onClick={toggleCollapsed}>
            <span className="sb-icon">{collapsed ? '⟩' : '⟨'}</span><span className="sb-label">{t('Collapse')}</span>
          </button>
        </nav>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <span className="brand-sub">{t('AI Session Time Machine')}</span>
          <div className="topbar-right">
            {liveInfo && view.name === 'session' && (
              <span className={`pill live-pill ${liveInfo.status}`} title="Live streaming from the session log">
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
          <SessionView key={view.id} sessionId={view.id}
            onLiveChange={setLiveInfo}
            onRailChange={setRail}
            onSwitchSession={(sid) => setView({ name: 'session', id: sid, projectId: view.projectId })}
            onBack={() => setView({ name: 'project', id: view.projectId })} />
        )}
        {view.name === 'hub' && <HubPage />}
        {view.name === 'skills' && <SkillsPage />}
        {view.name === 'security' && <SecurityPage />}
      </div>

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onImported={() => { refresh(); }} />
      )}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}

// Feedback modal (Chronicle-style): sends through the local server, which relays
// to email and always keeps a local copy in ~/.chronicle/feedback.log.
function FeedbackModal({ onClose }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | sent | failed
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.focus(); }, []);

  async function send() {
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    try {
      await api.sendFeedback(text.trim());
      setState('sent');
      setTimeout(onClose, 1200);
    } catch {
      setState('failed');
      // Relay unreachable — fall back to the user's mail client, pre-filled.
      window.open(`mailto:chizhangucb@gmail.com?subject=${encodeURIComponent('Chronicle feedback')}&body=${encodeURIComponent(text.trim())}`);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('Feedback')}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted small">{t("Tell us about any issues you encountered or improvements you'd like to see.")}</p>
        <label className="small feedback-label">{t('Description')}</label>
        <textarea ref={boxRef} className="feedback-box" rows={5}
          placeholder={t('Describe the issue or suggestion…')}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} />
        <div className="muted small">{t('Press ⌘+Enter to send')}</div>
        {state === 'sent' && <div className="ok small">✓ {t('Thanks — feedback sent!')}</div>}
        {state === 'failed' && <div className="error-banner small">{t('Email relay unreachable — opened your mail app instead (a local copy was saved).')}</div>}
        <div className="feedback-actions">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!text.trim() || state === 'sending'} onClick={send}>
            {state === 'sending' ? t('Sending…') : `⌁ ${t('Send')}`}
          </button>
        </div>
      </div>
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
