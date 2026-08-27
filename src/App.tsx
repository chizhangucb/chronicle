import React, { useEffect, useState, useCallback } from 'react';
import { useLocation, useRoute, useSearch } from 'wouter';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Toast from '@radix-ui/react-toast';
import { api, type Settings } from './api.js';
import ImportWizard from './ImportWizard.tsx';
import ProjectDetail from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import SearchModal from './SearchModal.tsx';
import HomeDashboard from './HomeDashboard.jsx';
import ProjectsPage from './ProjectsPage.jsx';
import ModulesPage from './ModulesPage.tsx';
import SafetyPage from './SafetyPage.tsx';
import JobsPage from './JobsPage.tsx';
import BriefingPage from './BriefingPage.tsx';
import MemoryPage from './MemoryPage.tsx';
import RecordsPage from './RecordsPage.tsx';
import AskPage from './AskPage.tsx';
import { useHubStatus } from './useHubStatus.ts';
import { useAskStatus } from './useAskStatus.ts';
import Modal from './Modal.tsx';
import { useResizable } from './useResizable.ts';
import { useSyncStatus } from './useSyncStatus.js';
import { CostModeProvider, CostModeToggle } from './costMode.tsx';
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
  // Any session in the project has an open live watcher or ended in the last
  // 5 minutes (server/routes/projects.ts, Task 17).
  live: boolean;
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
  const [atProjects] = useRoute('/projects');
  const [atProject, projectParams] = useRoute('/project/:id');
  // Project sub-tabs (5e-4): Explore/Content are deep-linkable routes, but
  // ProjectDetail owns the actual tab logic (it re-reads these same routes
  // itself) — App only needs to know these paths resolve to the project view.
  const [atProjExplore, peParams] = useRoute('/project/:id/explore');
  const [atProjContent, pcParams] = useRoute('/project/:id/content');
  const [atSession, sessionParams] = useRoute('/session/:id');
  // `/insights` is the OLD Insights URL (may be bookmarked). It now redirects to
  // `/` (the merged Home/Insights hub), preserving a `?tab=` deep-link if present.
  const [atInsights] = useRoute('/insights');
  // Ops routes (CHI-323) are hub-conditional: rendered only when the hub adapter
  // reports present (live or demo). Hidden + unreachable when absent.
  const [atModules] = useRoute('/modules');
  const [atSafety] = useRoute('/safety');
  const [atJobs] = useRoute('/jobs');
  const [atBriefing] = useRoute('/briefing');
  const [atMemory] = useRoute('/memory');
  const [atRecords] = useRoute('/records');
  const [atAsk] = useRoute('/ask');
  const hub = useHubStatus();
  const hubPresent = hub?.present ?? false;
  const { status: askStatus, refresh: refreshAsk } = useAskStatus();
  const askEnabled = askStatus?.enabled ?? false;
  const search = useSearch();
  const projectId = projectParams?.id ?? peParams?.id ?? pcParams?.id;
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
  // Drag-to-resize width for the expanded sidebar (persisted, mirrors the
  // collapse pattern above). Ignored while collapsed — the fixed 56px width
  // wins there, so a persisted width never fights the collapse state.
  const sidebar = useResizable({ storageKey: 'chronicle.sidebarW', fallback: 192, min: 160, max: 320, edge: 'right' });
  // Passive sync indicator + click-to-sync-now, rendered in the topbar so it's
  // visible on EVERY page (Task 17) — previously only shown on /projects.
  const sync = useSyncStatus();

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { if (atHome || atProjects) refresh(); }, [atHome, atProjects, refresh]);

  // Redirect the old `/insights` URL to the merged hub at `/`, preserving a
  // `?tab=` deep-link (`/insights?tab=explore` → `/?tab=explore`). `replace`
  // keeps it out of history so Back doesn't bounce between the two.
  useEffect(() => {
    if (!atInsights) return;
    const tab = new URLSearchParams(search).get('tab');
    navigate(tab && tab !== 'overview' ? `/?tab=${tab}` : '/', { replace: true });
  }, [atInsights, search, navigate]);

  // Deep link: a `#session=<id>` hash resolves the owning project and
  // navigates to that session (used by external openers linking into the app).
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
      // Cmd-J routes to /ask from anywhere and focuses the input (CHI-351).
      // Only when Ask is enabled (toggle + CLI + non-demo) so the shortcut never
      // lands on a soft-failed route.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J') && askEnabled) {
        e.preventDefault();
        navigate('/ask');
        window.dispatchEvent(new Event('ask:focus'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askEnabled, navigate]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem('chronicle-sidebar', c ? 'expanded' : 'collapsed');
      return !c;
    });
  }

  // Sidebar "Projects" highlights across every project-scoped route (the grid,
  // a project's analytics, a session opened from one) — but not on Home.
  const inProjectArea = atProjects || atProject || atSession || atProjExplore || atProjContent;

  return (
    <CostModeProvider>
    <Toast.Provider swipeDirection="right">
    <div className="app">
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}
        style={collapsed ? undefined : { width: sidebar.width }}>
        <div className="sb-brand" title="Chronicle" onClick={() => navigate('/')}>
          <span className="brand-mark">◷</span>
          <span className="sb-label sb-brand-name">Chronicle</span>
        </div>

        <nav className="sb-top">
          <button className={`sb-item ${atHome && !rail ? 'on' : ''}`} title={t('Insights')}
            onClick={() => navigate('/')}>
            <span className="sb-icon">∑</span><span className="sb-label">{t('Insights')}</span>
          </button>
          <button className={`sb-item ${inProjectArea && !rail ? 'on' : ''}`} title={t('Projects')}
            onClick={() => navigate('/projects')}>
            <span className="sb-icon">◫</span><span className="sb-label">{t('Projects')}</span>
          </button>
          {/* Ops nav (CHI-323): hub-conditional. Rendered only when the hub is
              present (live or demo); hidden when absent. Enumerable: spec/surface-contract.md */}
          {hubPresent && (
            <button className={`sb-item ${atModules && !rail ? 'on' : ''}`} title={t('Modules')}
              onClick={() => navigate('/modules')}>
              <span className="sb-icon">▦</span><span className="sb-label">{t('Modules')}</span>
            </button>
          )}
          {hubPresent && (
            <button className={`sb-item ${atSafety && !rail ? 'on' : ''}`} title={t('Safety')}
              onClick={() => navigate('/safety')}>
              <span className="sb-icon">⊘</span><span className="sb-label">{t('Safety')}</span>
            </button>
          )}
          {hubPresent && (
            <button className={`sb-item ${atJobs && !rail ? 'on' : ''}`} title={t('Jobs')}
              onClick={() => navigate('/jobs')}>
              <span className="sb-icon">⧗</span><span className="sb-label">{t('Jobs')}</span>
            </button>
          )}
          {hubPresent && (
            <button className={`sb-item ${atBriefing && !rail ? 'on' : ''}`} title={t('Briefing')}
              onClick={() => navigate('/briefing')}>
              <span className="sb-icon">▣</span><span className="sb-label">{t('Briefing')}</span>
            </button>
          )}
          {hubPresent && (
            <button className={`sb-item ${atMemory && !rail ? 'on' : ''}`} title={t('Memory')}
              onClick={() => navigate('/memory')}>
              <span className="sb-icon">❖</span><span className="sb-label">{t('Memory')}</span>
            </button>
          )}
          {hubPresent && (
            <button className={`sb-item ${atRecords && !rail ? 'on' : ''}`} title={t('Records')}
              onClick={() => navigate('/records')}>
              <span className="sb-icon">≡</span><span className="sb-label">{t('Records')}</span>
            </button>
          )}
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
                <span className="sb-icon">◈</span><span className="sb-label">{t('Security Check')}</span>
              </button>
            </>
          )}
        </nav>

        <nav className="sb-bottom">
          {/* Ask (CHI-351): its OWN one-item group at the top of sb-bottom,
              fenced by a separator above AND below, signalling a cross-cutting
              capability (not nav, not chrome). Renders ONLY when enabled
              server-side (Settings toggle + claude CLI + non-demo). Not
              hub-conditional. Enumerable: spec/surface-contract.md */}
          {askEnabled && (
            <>
              <div className="sb-sep" />
              <button className={`sb-item ask-item ${atAsk && !rail ? 'on' : ''}`} title={`${t('Ask')}  ⌘J`}
                onClick={() => { navigate('/ask'); window.dispatchEvent(new Event('ask:focus')); }}>
                <span className="sb-icon">∴</span><span className="sb-label">{t('Ask')}</span>
              </button>
              <div className="sb-sep" />
            </>
          )}
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

      {!collapsed && (
        <div className="drag-handle" role="separator" aria-orientation="vertical"
          aria-label={t('Resize sidebar')} onPointerDown={sidebar.onHandlePointerDown} />
      )}

      <div className="app-main">
        <header className="topbar">
          <span className="brand-sub">{t('AI Session Time Machine')}</span>
          <div className="topbar-right">
            <CostModeToggle />
            <button type="button" className={`sync sync-btn ${sync.running ? 'running' : ''} ${sync.failed ? 'failed' : ''}`}
              title={t('Sync now')} onClick={sync.runNow} disabled={sync.running}>
              {sync.text}
            </button>
            {liveInfo && atSession && (
              <span className={`pill live-pill ${liveInfo.status}`} title="Live streaming from the session log">
                {liveInfo.status === 'live' ? '● LIVE' : liveInfo.status === 'reconnecting' ? '◌ Reconnecting…' : '○ Stopped'}
              </span>
            )}
            <button className="btn icon-btn" title={`${t('Search')}  ⌘K`} onClick={() => setSearchOpen(true)}>⌕</button>
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
          <HomeDashboard projects={projects} onOpenProject={(id: number | string) => navigate(`/project/${id}`)}
            onOpenSession={(sid: string) => navigate(`/session/${encodeURIComponent(sid)}`)}
            onImport={() => setWizardOpen(true)} onRefresh={refresh} />
        )}
        {atProjects && (
          <ProjectsPage projects={projects} onOpenProject={(id: number | string) => navigate(`/project/${id}`)}
            onOpenSession={(sid: string) => navigate(`/session/${encodeURIComponent(sid)}`)}
            onImport={() => setWizardOpen(true)} onRefresh={refresh} />
        )}
        {atModules && <ModulesPage />}
        {atSafety && <SafetyPage />}
        {atJobs && <JobsPage />}
        {atBriefing && <BriefingPage />}
        {atMemory && <MemoryPage />}
        {atRecords && <RecordsPage />}
        {atAsk && (askEnabled
          ? <AskPage />
          : <div className="page center muted">{t('Ask is not available. Enable it in Settings (requires the claude CLI).')}</div>)}
        {(atProject || atProjExplore || atProjContent) && projectId != null && (
          <ProjectDetail key={projectId} id={projectId}
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} onAskChanged={refreshAsk} />}
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)}
          onOpen={(sid: string) => { setSearchOpen(false); navigate(`/session/${encodeURIComponent(sid)}`); }} />
      )}
    </div>
    <Toast.Viewport className="toast-viewport" />
    </Toast.Provider>
    </CostModeProvider>
  );
}

// Settings: auto-sync (server-side watchers + timer). `Settings` is imported
// from api.ts (the canonical type, derived from server/routes/settings.ts,
// which always returns both fields with concrete booleans — no index
// signature needed here).

export interface SettingsModalProps {
  onClose: () => void;
  onAskChanged?: () => void;
}

function SettingsModal({ onClose, onAskChanged }: SettingsModalProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => setSettings({
      autoSync: true, autoSyncPaused: false, ask: false,
      minorActiveMsThreshold: 5 * 60 * 1000, minorMessageCountThreshold: 10, planWindows: true,
      monthlyBudget: null,
    }));
  }, []);
  async function toggle(key: 'autoSync' | 'autoSyncPaused' | 'ask' | 'planWindows') {
    if (!settings) return;
    const next: Settings = { ...settings, [key]: !settings[key] };
    setSettings(next);
    try { setSettings(await api.patchSettings({ [key]: next[key] })); } catch {}
    // Re-check /ask/status so the sidebar entry appears/disappears without a reload.
    if (key === 'ask') onAskChanged?.();
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
              <span className="muted small">{t('Keep imported projects up to date automatically (on launch, periodically, and when source logs change)')}</span>
            </label>
            <label className="settings-row">
              <input type="checkbox" checked={settings.autoSyncPaused === true} disabled={settings.autoSync === false}
                onChange={() => toggle('autoSyncPaused')} />
              <span>{t('Pause auto-sync')}</span>
              <span className="muted small">{t('Temporarily stop importing new sessions without turning auto-sync off — resume any time')}</span>
            </label>
            <label className="settings-row">
              <input type="checkbox" checked={settings.planWindows !== false} onChange={() => toggle('planWindows')} />
              <span>{t('Claude plan windows (quota)')}</span>
              <span className="muted small">{t('The ONE outbound call in Chronicle: reads your Claude 5h / 7d / Fable quota from api.anthropic.com using Claude Code’s own token, exactly as Claude Code does. On by default (reads only your own quota); turn it off for a fully offline instance. The token is never stored or logged. Codex windows are always local.')}</span>
            </label>
            <label className="settings-row">
              <input type="checkbox" checked={settings.ask === true} onChange={() => toggle('ask')} />
              <span>{t('Ask (experimental)')}</span>
              <span className="muted small">{t('Enable the ∴ Ask page: a local chat that answers metric questions from chronicle.db by running your claude CLI with a single read-only query tool. Requires the claude CLI on your PATH. Nothing leaves your machine.')}</span>
            </label>
          </div>
        )}
    </Modal>
  );
}
