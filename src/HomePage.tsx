import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import { useSessionSelect } from './SessionSelect.js';
import { sessionDisplayName } from './ProjectDetail.js';
import type { Project } from '@shared/types.ts';
import type { RepoInfo } from './ProjectDetail.tsx';
import type { SearchResultItem } from './api.js';

// A project row as returned by GET /api/projects (server/routes/projects.ts
// ProjectListRow): the projects table columns plus aggregate counts and the
// embedded git repo info.
export interface ProjectSummary extends Project {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
  git: RepoInfo;
}

const SOURCE_ICONS: Record<string, string> = { 'claude-code': '✳', codex: '⬡', cursor: '▮' };

interface ProjectMenuProps {
  project: ProjectSummary;
  onOpenProject: (id: number | string) => void;
  onRefresh: () => void;
}

function ProjectMenu({ project, onOpenProject, onRefresh }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function run(action: 'sync' | 'details' | 'rename' | 'remove') {
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
      alert(String((e as Error).message));
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

export interface HomePageProps {
  projects: ProjectSummary[] | null;
  onOpenProject: (id: number | string) => void;
  onOpenSession?: (id: string, projectId: number) => void;
  onImport: () => void;
  onRefresh: () => void;
}

export default function HomePage({ projects, onOpenProject, onOpenSession, onImport, onRefresh }: HomePageProps) {
  // Recent-sessions stream: reuses GET /api/search's empty-query "recent"
  // mode (already excludes minor/gated sessions — see server/routes/search.ts),
  // mounting the SAME shared session multi-select delete component as the
  // project session list (see src/SessionSelect.tsx).
  const [recentSessions, setRecentSessions] = useState<SearchResultItem[] | null>(null);
  const refreshRecent = () => api.search({}).then((r) => setRecentSessions(r.results)).catch(() => setRecentSessions([]));
  useEffect(() => { refreshRecent(); }, []);
  const selectableRecent = (recentSessions ?? []).map((s) => ({ id: s.id, source: s.source, project_id: s.project_id }));
  const recentSelect = useSessionSelect(selectableRecent, () => { refreshRecent(); onRefresh(); });
  // Multi-select delete: a "Select" mode turns the whole grid into checkboxes so
  // several projects can be removed from Chronicle at once. Uses an inline confirm
  // bar (not window.confirm, which is blocked in embedded/preview browsers).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number | string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function exitSelect() { setSelectMode(false); setSelected(new Set()); setConfirming(false); }
  function toggle(id: number | string) {
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

      {!!recentSessions?.length && (
        <>
          <div className="page-title-row" style={{ marginTop: 24 }}>
            <h3 className="page-title">{t('Recent Sessions')}</h3>
            <div className="page-title-actions">{recentSelect.Bar}</div>
          </div>
          <div className="session-list">
            {recentSessions.map((s) => {
              const isSel = recentSelect.isSelected(s.id);
              return (
                <div key={s.id} className={`card session-row ${recentSelect.selectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''}`}
                  onClick={() => (recentSelect.selectMode ? recentSelect.toggle(s.id) : onOpenSession?.(s.id, s.project_id))}>
                  <div className="session-prompt">
                    {recentSelect.selectMode && <span className={`sel-check ${isSel ? 'on' : ''}`}>{isSel ? '☑' : '☐'}</span>}
                    {sessionDisplayName(s)}
                  </div>
                  <div className="session-meta muted small">
                    <span className="pill src-pill">{s.source}</span>
                    <span>{s.project_name}</span>
                    {s.ts && <span>{new Date(s.ts).toLocaleString()}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {recentSelect.Toast}
        </>
      )}

      <MinorSessionsBucket onRefresh={onRefresh} />
    </div>
  );
}

// ---- Global "minor sessions" bucket (noise gate — Phase 5 PR 5a) ----
// Sub-threshold sessions (short/low-message) are gated out of every main
// list at import time (server/db.ts replaceSession + server/noiseGate.ts).
// This is the single global collapsed surface where they still live, with
// promote (bring it back) / ignore (=tombstone, same as delete) actions.

interface MinorSession {
  id: string;
  project_id: number;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  message_count: number;
  agent_active_ms: number | null;
  project_name: string;
}

function MinorSessionsBucket({ onRefresh }: { onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MinorSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.minorSessions().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  async function promote(id: string) {
    setBusy(id);
    try { await api.promoteSession(id); await load(); onRefresh(); } finally { setBusy(null); }
  }
  async function ignore(id: string) {
    setBusy(id);
    try { await api.deleteSession(id); await load(); onRefresh(); } finally { setBusy(null); }
  }

  if (!items || !items.length) return null;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="page-title-row" style={{ margin: 0 }}>
        <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} {t('Minor sessions')} <span className="muted">({items.length})</span>
        </button>
        <span className="muted small" style={{ marginLeft: 8 }}>
          {t('Short, low-activity sessions kept out of the main lists — promote to restore, or ignore to remove them for good.')}
        </span>
      </div>
      {open && (
        <div className="session-list" style={{ marginTop: 8 }}>
          {items.map((s) => (
            <div key={s.id} className="card session-row">
              <div className="session-prompt">{sessionDisplayName(s)}</div>
              <div className="session-meta muted small">
                <span className="pill src-pill">{s.source}</span>
                <span>{s.project_name}</span>
                <span>{s.message_count} messages</span>
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                <button className="btn tiny ghost" disabled={busy === s.id} onClick={() => promote(s.id)}>⬆ {t('Promote')}</button>
                <button className="btn tiny ghost danger" disabled={busy === s.id} onClick={() => ignore(s.id)}>✕ {t('Ignore')}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
