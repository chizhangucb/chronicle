import React, { useEffect, useState, useCallback } from 'react';
import { useLocation, useRoute } from 'wouter';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Toast from '@radix-ui/react-toast';
import { api, type Settings } from './api.js';
import ImportWizard from './ImportWizard.tsx';
import ProjectDetail from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import SearchModal from './SearchModal.tsx';
import HomePage from './HomePage.jsx';
import Modal from './Modal.tsx';
import { t, lang, setLang, type Lang } from './i18n.js';
import type { Project } from '@shared/types.ts';
import type { LiveChangeInfo, RailState } from './SessionView.jsx';
import type { DeletedEntry } from './SessionSelect.js';

const LANGS: { key: Lang; label: string }[] = [
  { key: 'en', label: 'EN' },
  { key: 'zh', label: '中文' },
  { key: 'ja', label: '日本語' },
];

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

// Navigation is now driven by real URL routes (wouter): `/` (Home),
// `/project/:id`, `/session/:id`. The URL itself is the persisted state, so a
// reload (including the language switch's `location.reload()` in i18n.ts)
// restores the current view for free — no sessionStorage hack needed.

// Live-streaming pill state and session-mode rail config are owned by
// SessionView (the producer, via `onLiveChange`/`onRailChange`) — reuse its
// exported types here instead of duplicating them, so the two stay in sync.

export default function App() {
  const [, navigate] = useLocation();
  const [atHome] = useRoute('/');
  const [atProject, projectParams] = useRoute('/project/:id');
  const [atSession, sessionParams] = useRoute('/session/:id');
  const projectId = projectParams?.id;
  const sessionId = sessionParams?.id;
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // {status: 'live'|'reconnecting'|'stopped', sessionId?} — reported by the
  // session/project views so the pill stays visible anywhere in the project.
  const [liveInfo, setLiveInfo] = useState<LiveChangeInfo | null>(null);
  // Session mode rail config, registered by SessionView while it is mounted.
  const [rail, setRail] = useState<RailState | null>(null);
  // An Overview single-session delete (SessionView's onBack) carries the undo
  // payload here so ProjectDetail can surface the shared undo toast on landing.
  const [pendingUndo, setPendingUndo] = useState<DeletedEntry | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle-sidebar') === 'collapsed');

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (atHome) refresh(); }, [atHome, refresh]);

  // chronicle://session/<id> deep links: the Electron shell sets
  // location.hash to `session=<id>`; resolve the owning project and navigate.
  useEffect(() => {
    async function onHash() {
      const m = /^#session=(.+)$/.exec(location.hash);
      if (!m) return;
      location.hash = '';
      try {
        const s = await api.resolveSession(decodeURIComponent(m[1]));
        navigate(`/session/${encodeURIComponent(s.id)}`);
      } catch {}
    }
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [navigate]);

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

  const inProjects = atHome || atProject || atSession;

  return (
    <Toast.Provider swipeDirection="right">
    <div className="app">
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sb-brand" title="Chronicle" onClick={() => navigate('/')}>
          <span className="brand-mark">◷</span>
          <span className="sb-label sb-brand-name">Chronicle</span>
        </div>

        <nav className="sb-top">
          <button className={`sb-item ${inProjects && !rail ? 'on' : ''}`} title={t('Projects')}
            onClick={() => navigate('/')}>
            <span className="sb-icon">◷</span><span className="sb-label">{t('Projects')}</span>
            <span className={`sb-action ${syncingAll ? 'spin' : ''}`} role="button"
              title={t('Sync all projects — re-import the latest sessions from every source')}
              onClick={syncAll}>{syncingAll ? '◌' : '⟳'}</span>
          </button>
          {rail && (
            <>
              <div className="sb-sep" />
              <div className="sb-sec-head eyebrow">{t('Session')}</div>
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
            {liveInfo && atSession && (
              <span className={`pill live-pill ${liveInfo.status}`} title="Live streaming from the session log">
                {liveInfo.status === 'live' ? '● LIVE' : liveInfo.status === 'reconnecting' ? '◌ Reconnecting…' : '○ Stopped'}
              </span>
            )}
            <button className="btn ghost icon-btn" title={`${t('Search')}  ⌘K`} onClick={() => setSearchOpen(true)}>🔍</button>
            <button className="btn primary" onClick={() => setWizardOpen(true)}>{t('+ Import Sessions')}</button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="lang-select" title="Language / 语言">
                  {LANGS.find((l) => l.key === lang())?.label ?? 'EN'}
                  <span className="car">▾</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-pop" align="end" sideOffset={6}>
                  {LANGS.map((l) => (
                    <DropdownMenu.Item key={l.key} className="menu-item" onSelect={() => setLang(l.key)}>
                      {l.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {atHome && (
          <HomePage projects={projects} onOpenProject={(id: number | string) => navigate(`/project/${id}`)}
            onOpenSession={(sid: string) => navigate(`/session/${encodeURIComponent(sid)}`)}
            onImport={() => setWizardOpen(true)} onRefresh={refresh} />
        )}
        {atProject && projectId != null && (
          <ProjectDetail id={projectId}
            onBack={() => navigate('/')}
            onLiveChange={setLiveInfo}
            onOpenProject={(pid: number | string) => navigate(`/project/${pid}`)}
            onOpenSession={(sid: string) => navigate(`/session/${encodeURIComponent(sid)}`)}
            pendingUndo={pendingUndo} />
        )}
        {atSession && sessionId != null && (
          <SessionView key={sessionId} sessionId={sessionId}
            onLiveChange={setLiveInfo}
            onRailChange={setRail}
            onSwitchSession={(sid: string) => navigate(`/session/${encodeURIComponent(sid)}`)}
            onBack={(undo?: DeletedEntry, backProjectId?: number) => {
              setPendingUndo(undo ?? null);
              navigate(backProjectId != null ? `/project/${backProjectId}` : '/');
            }} />
        )}
      </div>

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onImported={() => { refresh(); }} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)}
          onOpen={(sid: string) => { setSearchOpen(false); navigate(`/session/${encodeURIComponent(sid)}`); }} />
      )}
    </div>
    <Toast.Viewport className="toast-viewport" />
    </Toast.Provider>
  );
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
    api.settings().then(setSettings).catch(() => setSettings({
      autoSync: true, autoSyncPaused: false, launchAtLogin: false,
      minorActiveMsThreshold: 5 * 60 * 1000, minorMessageCountThreshold: 10,
    }));
  }, []);
  async function toggle(key: 'autoSync' | 'autoSyncPaused' | 'launchAtLogin') {
    if (!settings) return;
    const next: Settings = { ...settings, [key]: !settings[key] };
    setSettings(next);
    try { setSettings(await api.patchSettings({ [key]: next[key] })); } catch {}
  }
  return (
    <Modal onClose={onClose} title={t('Settings')}>
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
            <label className="settings-row">
              <input type="checkbox" checked={settings.autoSyncPaused === true} disabled={settings.autoSync === false}
                onChange={() => toggle('autoSyncPaused')} />
              <span>{t('Pause auto-sync')}</span>
              <span className="muted small">{t('Temporarily stop importing new sessions without turning auto-sync off — resume any time')}</span>
            </label>
          </div>
        )}
    </Modal>
  );
}
