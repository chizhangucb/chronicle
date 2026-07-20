import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import ImportWizard from './ImportWizard.jsx';
import ProjectDetail, { sessionDisplayName } from './ProjectDetail.jsx';
import SessionView from './SessionView.jsx';
import HubPage from './HubPage.jsx';
import { t, lang, setLang } from './i18n.js';
import SkillsPage from './SkillsPage.jsx';
import SecurityPage from './SecurityPage.jsx';
import SponsorModal from './SponsorModal.jsx';

const SOURCE_ICONS = { 'claude-code': '✳', codex: '⬡', cursor: '▮', 'gemini-cli': '✦' };

export default function App() {
  // view: {name:'home'} | {name:'project', id} | {name:'session', id, projectId}
  // Restore from sessionStorage so a full page reload (the language switch reloads
  // to re-translate module-scope strings) keeps you where you were, instead of
  // dropping to Home. sessionStorage → a fresh app launch still starts at Home.
  const [view, setView] = useState(() => {
    try { const s = sessionStorage.getItem('chronicle-view'); if (s) return JSON.parse(s); } catch {}
    return { name: 'home' };
  });
  useEffect(() => {
    try { sessionStorage.setItem('chronicle-view', JSON.stringify(view)); } catch {}
  }, [view]);
  const [projects, setProjects] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // ⌘K / Ctrl+K opens the global search palette from anywhere.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [syncingAll, setSyncingAll] = useState(false);
  async function syncAll(e) {
    e.stopPropagation();
    if (syncingAll) return;
    setSyncingAll(true);
    try {
      const list = await api.projects();
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
          <button className="sb-item util" title={t('Sponsor')} onClick={() => setSponsorOpen(true)}>
            <span className="sb-icon">♥</span><span className="sb-label">{t('Sponsor')}</span>
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
            <button className="btn ghost icon-btn" title={`${t('Search')}  ⌘K`} onClick={() => setSearchOpen(true)}>🔍</button>
            <button className="btn primary" onClick={() => setWizardOpen(true)}>{t('+ Import Sessions')}</button>
            <select className="chip lang-select" title="Language / 语言" value={lang()}
              onChange={(e) => setLang(e.target.value)}>
              <option value="en">EN</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
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
            onOpenProject={(pid) => setView({ name: 'project', id: pid })}
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
      {sponsorOpen && <SponsorModal onClose={() => setSponsorOpen(false)} />}
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)}
          onOpen={(sid, pid) => { setSearchOpen(false); setView({ name: 'session', id: sid, projectId: pid }); }} />
      )}
      <UpdateBanner />
    </div>
  );
}

// Feedback modal: sends through the local server, which relays
// to email and always keeps a local copy in ~/.chronicle/feedback.log.
function FeedbackModal({ onClose }) {
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | sent | failed
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.focus(); }, []);

  async function send() {
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    try {
      await api.sendFeedback(text.trim(), email.trim());
      setState('sent');
      setTimeout(onClose, 1200);
    } catch {
      setState('failed');
      // Relay unreachable — fall back to the user's mail client, pre-filled. Their
      // own From address is the reply path, so no need to embed the email here.
      window.open(`mailto:feedback@getchronicle.dev?subject=${encodeURIComponent('Chronicle feedback')}&body=${encodeURIComponent(text.trim())}`);
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
        <label className="small feedback-label">{t('Your email (optional)')}</label>
        <input className="feedback-email" type="email" autoComplete="email"
          placeholder={t('name@example.com — so we can reply to you')}
          value={email} onChange={(e) => setEmail(e.target.value)}
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

// Auto-update toast: shown only inside the Electron shell (window.chronicleUpdater
// exists) once an update has downloaded. Clicking Relaunch installs + relaunches
// via electron-updater's quitAndInstall (clean port handover — no stale process).
function UpdateBanner() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    const u = typeof window !== 'undefined' ? window.chronicleUpdater : null;
    if (!u) return;
    u.onDownloaded((info) => setVersion(info?.version || ''));
  }, []);
  if (version === null) return null;
  return (
    <div className="update-toast" role="status">
      <div className="update-toast-body">
        <div className="update-toast-title">{t('Updated to')} {version}</div>
        <div className="update-toast-sub">{t('Relaunch to apply')}</div>
      </div>
      <button className="btn primary" onClick={() => window.chronicleUpdater?.relaunch()}>
        {t('Relaunch')}
      </button>
    </div>
  );
}

// Global search palette (⌘K): All/Code/Chat scope, time + project
// filters, "Recent Access" when empty. Server does a LIKE scan grouped per session.
const SEARCH_SCOPES = [
  { key: 'all', label: 'All', icon: '≡' },
  { key: 'code', label: 'Code', icon: '</>' },
  { key: 'chat', label: 'Chat', icon: '💬' },
];
const SEARCH_RANGES = [
  { key: '', label: 'All Time' },
  { key: '7', label: '7 Days' },
  { key: '30', label: '30 Days' },
  { key: '365', label: '1 Year' },
];

function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts)) / 1000);
  if (s < 60) return t('just now');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${t(m === 1 ? 'minute ago' : 'minutes ago')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t(h === 1 ? 'hour ago' : 'hours ago')}`;
  const d = Math.floor(h / 24);
  return d === 1 ? t('1 day ago') : `${d} ${t('days ago')}`;
}

function searchHighlight(text, q) {
  if (!text || !q) return text;
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  const parts = [];
  let i = 0, idx;
  while ((idx = lower.indexOf(needle, i)) !== -1 && parts.length < 40) {
    parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function SearchModal({ onClose, onOpen }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState('all');
  const [days, setDays] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState([]);
  const [data, setData] = useState({ recent: true, results: [] });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); api.projects().then(setProjects).catch(() => {}); }, []);
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(id); }, [q]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const params = { q: debounced, scope };
    if (days) params.days = days;
    if (projectId) params.project = projectId;
    api.search(params).then((d) => { if (!stale) { setData(d); setActive(0); } })
      .catch(() => { if (!stale) setData({ recent: !debounced, results: [] }); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [debounced, scope, days, projectId]);

  const results = data.results || [];
  function open(r) { if (r) onOpen(r.id, r.project_id); }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="search-input-row">
          <span className="search-mag">🔍</span>
          <input ref={inputRef} className="search-input" placeholder={t('Search session content…')}
            value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="kbd">⌘K</span>
          <button className="btn ghost tiny" onClick={onClose}>✕</button>
        </div>
        <div className="search-filters">
          <span className="search-tabs">
            {SEARCH_SCOPES.map((s) => (
              <button key={s.key} className={`chip ${scope === s.key ? 'on' : ''}`} onClick={() => setScope(s.key)}>
                <span className="search-tab-icon">{s.icon}</span> {t(s.label)}
              </button>
            ))}
          </span>
          <span className="search-selects">
            <select className="chip range-select" value={days} onChange={(e) => setDays(e.target.value)}>
              {SEARCH_RANGES.map((r) => <option key={r.key} value={r.key}>📅 {t(r.label)}</option>)}
            </select>
            <select className="chip range-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">📁 {t('All Projects')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
        </div>
        <div className="search-results" ref={listRef}>
          {data.recent && <div className="search-section muted small">{t('Recent Access')}</div>}
          {results.map((r, i) => (
            <button key={r.id} data-idx={i} className={`search-row ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
              <span className="search-row-clock">🕘</span>
              <span className="search-row-body">
                <span className="search-row-title">
                  <span className="search-row-project">{r.project_name}</span>
                  <span className="search-row-sep">/</span>
                  <span className="search-row-name">{sessionDisplayName(r)}</span>
                </span>
                {r.snippet && <span className="search-row-snippet muted small">{searchHighlight(r.snippet, debounced)}</span>}
              </span>
              <span className="search-row-meta muted small">
                {r.matchCount > 0 && <span className="search-row-count">{r.matchCount} {t(r.matchCount === 1 ? 'match' : 'matches')}</span>}
                <span>{relTime(r.ts)}</span>
              </span>
            </button>
          ))}
          {!loading && !results.length && (
            <div className="muted small pad8 center">{t('No results found')}</div>
          )}
        </div>
        <div className="search-footer muted small">
          <span>↑ ↓ {t('Navigate')}</span><span>↵ {t('Select')}</span><span>Esc {t('Close')}</span>
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
  // Multi-select delete: a "Select" mode turns the whole grid into checkboxes so
  // several projects can be removed from Chronicle at once. Uses an inline confirm
  // bar (not window.confirm, which is blocked in embedded/preview browsers).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function exitSelect() { setSelectMode(false); setSelected(new Set()); setConfirming(false); }
  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirming(false);
  }
  async function deleteSelected() {
    if (deleting || !selected.size) return;
    setDeleting(true);
    try {
      for (const id of selected) {
        try { await api.deleteProject(id); } catch {}
      }
      onRefresh();
      exitSelect();
    } finally {
      setDeleting(false);
    }
  }

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

  const allSelected = selected.size === projects.length && projects.length > 0;

  return (
    <div className="page">
      <div className="page-title-row">
        <h2 className="page-title">{t('Projects')} <span className="muted">({projects.length})</span></h2>
        <div className="page-title-actions">
          {!selectMode ? (
            <button className="btn ghost" onClick={() => setSelectMode(true)}>☑ {t('Select')}</button>
          ) : confirming ? (
            <>
              <span className="muted small">{t('Remove these from Chronicle? Source logs and folders are not touched.')}</span>
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={deleting}>{t('Cancel')}</button>
              <button className="btn danger-btn" onClick={deleteSelected} disabled={deleting}>
                {deleting ? t('Removing…') : `🗑 ${t('Remove')} ${selected.size}`}
              </button>
            </>
          ) : (
            <>
              <span className="muted small">{selected.size} {t('selected')}</span>
              <button className="btn ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id)))}>
                {allSelected ? t('Clear') : t('Select all')}
              </button>
              <button className="btn ghost" onClick={exitSelect}>{t('Cancel')}</button>
              <button className="btn danger-btn" disabled={!selected.size} onClick={() => setConfirming(true)}>
                🗑 {t('Remove')}{selected.size ? ` (${selected.size})` : ''}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="project-grid">
        {projects.map((p) => {
          const isSel = selected.has(p.id);
          return (
            <div key={p.id} className={`card project-card ${selectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''}`}
              onClick={() => (selectMode ? toggle(p.id) : onOpenProject(p.id))}>
              <div className="project-card-head">
                <span className="project-name">
                  {selectMode && <span className={`sel-check ${isSel ? 'on' : ''}`}>{isSel ? '☑' : '☐'}</span>}
                  {p.name}
                </span>
                <span className="project-card-actions">
                  {p.git?.isRepo && <span className="pill git-pill" title={`${p.git.commitCount} commits`}>⎇ {p.git.branch}</span>}
                  {!selectMode && <ProjectMenu project={p} onOpenProject={onOpenProject} onRefresh={onRefresh} />}
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
          );
        })}
      </div>
    </div>
  );
}
