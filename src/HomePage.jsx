import React, { useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';

const SOURCE_ICONS = { 'claude-code': '✳', codex: '⬡', cursor: '▮' };

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

export default function HomePage({ projects, onOpenProject, onImport, onRefresh }) {
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
