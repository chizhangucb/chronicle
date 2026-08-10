import React, { useEffect, useState, useCallback } from 'react';
import { api, type Settings } from './api.js';
import ImportWizard from './ImportWizard.tsx';
import ProjectDetail from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import SearchModal from './SearchModal.tsx';
import HomePage from './HomePage.jsx';
import { t, lang, setLang, type Lang } from './i18n.js';
import type { Project } from '@shared/types.ts';
import type { LiveChangeInfo, RailState } from './SessionView.jsx';

// The `/api/projects` list response: a Project row plus per-project aggregates
// (session_count/message_count/last_active/sources — server/routes/projects.ts
// ProjectListRow) and the live `git` pill info (server/git.ts RepoInfo), computed
// fresh on every call (no caching).
export interface ProjectListItem extends Project {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
  git: { isRepo: boolean; commitCount?: number; branch?: string | null };
}

// view: {name:'home'} | {name:'project', id} | {name:'session', id, projectId}
// Restore from sessionStorage so a full page reload (the language switch reloads
// to re-translate module-scope strings) keeps you where you were, instead of
// dropping to Home. sessionStorage → a fresh app launch still starts at Home.
// `id`/`projectId` are `number | string` to match ProjectDetail/HomePage's
// project-id callbacks (which stay loose since several api.ts calls accept
// either); Project.id is always a number in practice.
export type View =
  | { name: 'home' }
  | { name: 'project'; id: number | string }
  | { name: 'session'; id: string; projectId: number | string };

// Live-streaming pill state and session-mode rail config are owned by
// SessionView (the producer, via `onLiveChange`/`onRailChange`) — reuse its
// exported types here instead of duplicating them, so the two stay in sync.

export default function App() {
  const [view, setView] = useState<View>(() => {
    try {
      const s = sessionStorage.getItem('chronicle-view');
      if (s) return JSON.parse(s) as View;
    } catch {}
    return { name: 'home' };
  });
  useEffect(() => {
    try { sessionStorage.setItem('chronicle-view', JSON.stringify(view)); } catch {}
  }, [view]);
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // {status: 'live'|'reconnecting'|'stopped', sessionId?} — reported by the
  // session/project views so the pill stays visible anywhere in the project.
  const [liveInfo, setLiveInfo] = useState<LiveChangeInfo | null>(null);
  // Session mode rail config, registered by SessionView while it is mounted.
  const [rail, setRail] = useState<RailState | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle-sidebar') === 'collapsed');

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (view.name === 'home') refresh(); }, [view.name, refresh]);

  // chronicle://session/<id> deep links: the Electron shell sets
  // location.hash to `session=<id>`; resolve the owning project and navigate.
  useEffect(() => {
    async function onHash() {
      const m = /^#session=(.+)$/.exec(location.hash);
      if (!m) return;
      location.hash = '';
      try {
        const s = await api.resolveSession(decodeURIComponent(m[1]));
        setView({ name: 'session', id: s.id, projectId: s.project_id });
      } catch {}
    }
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ⌘K / Ctrl+K opens the global search palette from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [syncingAll, setSyncingAll] = useState(false);
  async function syncAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (syncingAll) return;
    setSyncingAll(true);
    try {
      const list: ProjectListItem[] = await api.projects();
      for (const p of list) {
        // Tolerate projects with no matching source logs (moved/deleted).
        try { await api.syncProject(p.id); } catch {}
      }
      refresh();
    } finally {
      setSyncingAll(false);
    }
  }

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
            <span className={`sb-action ${syncingAll ? 'spin' : ''}`} role="button"
              title={t('Sync all projects — re-import the latest sessions from every source')}
              onClick={syncAll}>{syncingAll ? '◌' : '⟳'}</span>
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
          <button className="sb-item util" title={t('Settings')} onClick={() => setSettingsOpen(true)}>
            <span className="sb-icon">⚙</span><span className="sb-label">{t('Settings')}</span>
          </button>
          <a className="sb-item util" href="https://github.com/chizhangucb/chronicle/issues" target="_blank" rel="noreferrer" title={t('Feedback')}>
            <span className="sb-icon">⊞</span><span className="sb-label">{t('Feedback')}</span>
          </a>
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
            <button className="btn ghost icon-btn" title={`${t('Search')}  ⌘K`} onClick={() => setSearchOpen(true)}>🔍</button>
            <button className="btn primary" onClick={() => setWizardOpen(true)}>{t('+ Import Sessions')}</button>
            <select className="chip lang-select" title="Language / 语言" value={lang()}
              onChange={(e) => setLang(toLang(e.target.value))}>
              <option value="en">EN</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
            </select>
          </div>
        </header>

        {view.name === 'home' && (
          <HomePage projects={projects} onOpenProject={(id: number | string) => setView({ name: 'project', id })}
            onImport={() => setWizardOpen(true)} onRefresh={refresh} />
        )}
        {view.name === 'project' && (
          <ProjectDetail id={view.id}
            onBack={() => setView({ name: 'home' })}
            onLiveChange={setLiveInfo}
            onOpenProject={(pid: number | string) => setView({ name: 'project', id: pid })}
            onOpenSession={(sid: string) => setView({ name: 'session', id: sid, projectId: view.id })} />
        )}
        {view.name === 'session' && (
          <SessionView key={view.id} sessionId={view.id}
            onLiveChange={setLiveInfo}
            onRailChange={setRail}
            onSwitchSession={(sid: string) => setView({ name: 'session', id: sid, projectId: view.projectId })}
            onBack={() => setView({ name: 'project', id: view.projectId })} />
        )}
      </div>

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onImported={() => { refresh(); }} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)}
          onOpen={(sid: string, pid: number) => { setSearchOpen(false); setView({ name: 'session', id: sid, projectId: pid }); }} />
      )}
    </div>
  );
}

// Narrows the raw <select> value (always `string` at the DOM level) to the
// `Lang` union instead of casting — falls back to 'en' for anything unknown.
function toLang(v: string): Lang {
  return v === 'zh' || v === 'ja' ? v : 'en';
}

// Settings: auto-sync (server-side watchers + timer). `Settings` is imported
// from api.ts (the canonical type, derived from server/routes/settings.ts,
// which always returns both fields with concrete booleans — no index
// signature needed here).

export interface SettingsModalProps {
  onClose: () => void;
}

function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => setSettings({ autoSync: true, launchAtLogin: false }));
  }, []);
  async function toggle(key: keyof Settings) {
    if (!settings) return;
    const next: Settings = { ...settings, [key]: !settings[key] };
    setSettings(next);
    try { setSettings(await api.patchSettings({ [key]: next[key] })); } catch {}
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('Settings')}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        {!settings ? <div className="muted pad8">…</div> : (
          <div className="pad8">
            <label className="settings-row">
              <input type="checkbox" checked={settings.autoSync !== false} onChange={() => toggle('autoSync')} />
              <span>{t('Auto-sync sessions')}</span>
              <span className="muted small">{t('Keep imported projects up to date automatically (on launch, on wake, and when source logs change)')}</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
