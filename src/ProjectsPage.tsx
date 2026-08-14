import React, { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from './api.js';
import { t } from './i18n.js';
import { formatRelativeTime } from './relativeTime.js';
import { projectColorMap } from './colors.js';
import { invalidateClientCache } from './useCachedFetch.ts';
import type { Project } from '@shared/types.ts';
import type { RepoInfo } from './ProjectDetail.tsx';

// A project row as returned by GET /api/projects (server/routes/projects.ts
// ProjectListRow): the projects table columns plus aggregate counts and the
// embedded git repo info.
export interface ProjectSummary extends Project {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
  git: RepoInfo;
  // Any session in the project has an open live watcher or ended in the last
  // 5 minutes (server/routes/projects.ts, Task 17).
  live: boolean;
}

interface ProjectMenuProps {
  project: ProjectSummary;
  onRefresh: () => void;
}

// Per-project options (Sync / Rename / Remove). Every destructive or
// text-input step is an INLINE affordance inside the dropdown, never
// window.confirm/prompt — those silently no-op in embedded/preview browsers
// (see CLAUDE.md). `open` is controlled so a click-away resets the confirm
// state. Moved here from the old HomePage with the project grid (Task 13).
// "View Details" was removed (Task 17) — the card itself is already a click
// target that navigates to the project.
function ProjectMenu({ project, onRefresh }: ProjectMenuProps) {
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(action: 'sync' | 'remove') {
    setErr(null);
    try {
      if (action === 'sync') {
        setSyncing(true);
        await api.syncProject(project.id);
        invalidateClientCache();
        onRefresh();
      } else if (action === 'remove') {
        setRemoving(true);
        await api.deleteProject(project.id);
        invalidateClientCache();
        onRefresh();
      }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setSyncing(false);
      setRemoving(false);
    }
  }

  async function saveRename() {
    if (savingName) return;
    const name = nameDraft.trim();
    if (!name) { setRenaming(false); return; }
    setErr(null);
    setSavingName(true);
    try {
      await api.renameProject(project.id, name);
      invalidateClientCache();
      setRenaming(false); setOpen(false); onRefresh();
    }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setSavingName(false); }
  }

  return (
    <span className="project-menu" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setConfirmRemove(false); setRenaming(false); setErr(null); } }}>
        <DropdownMenu.Trigger asChild>
          <button className={`btn tiny ghost gear ${syncing ? 'spin' : ''}`} title={t('Project options')}>
            {syncing ? '◌' : '⚙'}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-pop" align="end" sideOffset={6}>
            {renaming ? (
              <div className="menu-confirm" onKeyDown={(e) => e.stopPropagation()}>
                <input className="search" autoFocus value={nameDraft} disabled={savingName}
                  placeholder={project.name}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(false); }} />
                {err && <span className="menu-err small">{err}</span>}
                <div className="menu-confirm-actions">
                  <button className="btn tiny ghost" disabled={savingName} onClick={() => setRenaming(false)}>{t('Cancel')}</button>
                  <button className="btn tiny primary" disabled={savingName} onClick={saveRename}>{savingName ? t('Loading…') : `✓ ${t('Rename')}`}</button>
                </div>
              </div>
            ) : confirmRemove ? (
              <div className="menu-confirm">
                <span className="muted small">
                  {t('Remove')} "{project.name}" {t('from Chronicle? Your source logs and project folder are not touched.')}
                </span>
                <div className="menu-confirm-actions">
                  <button className="btn tiny ghost" disabled={removing} onClick={() => setConfirmRemove(false)}>
                    {t('Cancel')}
                  </button>
                  <button className="btn tiny danger-btn" disabled={removing} onClick={() => run('remove')}>
                    {removing ? t('Removing…') : `⌫ ${t('Remove')}`}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <DropdownMenu.Item className="menu-item" onSelect={() => run('sync')}>⟳ {t('Sync Update')}</DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={(e) => { e.preventDefault(); setNameDraft(project.name); setErr(null); setRenaming(true); }}>✎ {t('Rename')}</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item danger" onSelect={(e) => { e.preventDefault(); setConfirmRemove(true); }}>
                  ⌫ {t('Remove from Chronicle')}
                  <span className="muted small">{t("(won't delete source project)")}</span>
                </DropdownMenu.Item>
                {err && <div className="menu-err small" style={{ padding: '6px 8px' }}>{err}</div>}
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

// Shared empty state (no projects imported yet) — reused by ProjectsPage and
// the Home dashboard, so "import your first project" reads identically on both.
export function WelcomeEmpty({ onImport }: { onImport: () => void }) {
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

export interface ProjectsPageProps {
  projects: ProjectSummary[] | null;
  onOpenProject: (id: number | string) => void;
  onImport: () => void;
  onRefresh: () => void;
}

// `/projects` — a dense rail-style list, moved off Home (Task 13). This is
// the Chi-confirmed contract: the SAME row anatomy as the pre-Batch-C
// `.rail-proj` sidebar rows (pdot · name · live dot … session count · gear
// menu, meta line = branch/"needs association" · relative time), just laid
// out as a page instead of a 264px sidebar — never the bordered card grid
// Batch C shipped instead (F2 restore). Each row opens the project's
// analytics; its gear menu carries Sync/Rename/Remove.
export default function ProjectsPage({ projects, onOpenProject, onImport, onRefresh }: ProjectsPageProps) {
  const projectColors = useMemo(() => projectColorMap(projects?.map((p) => p.id) ?? []), [projects]);

  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) return <WelcomeEmpty onImport={onImport} />;

  return (
    <div className="page projects-page">
      <div className="page-title-row">
        <h1 className="page-title">{t('Projects')}</h1>
      </div>
      <div className="projects-list">
        {projects.map((p) => (
          <div key={p.id} className="rail-proj" onClick={() => onOpenProject(p.id)}>
            <div className="n">
              <span>
                <span className="pdot" style={{ background: projectColors.get(p.id) ?? 'var(--ink-3)' }} />
                {p.name}
                {p.live && <span className="live-dot on" title={t('A session in this project is live')} aria-hidden="true" />}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="c num">{p.session_count}</span>
                <ProjectMenu project={p} onRefresh={onRefresh} />
              </span>
            </div>
            <div className="meta">
              {p.git?.isRepo ? <span className="git">⎇ {p.git.branch}</span> : <span>{t('needs association')}</span>}
              {p.last_active && <><span>·</span><span>{formatRelativeTime(p.last_active)}</span></>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
