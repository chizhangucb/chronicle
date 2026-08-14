import React, { useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from './api.js';
import { t } from './i18n.js';
import { formatRelativeTime } from './relativeTime.js';
import { projectColorMap } from './colors.js';
import { invalidateClientCache } from './useCachedFetch.ts';
import RecentLedger from './RecentLedger.js';
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
  onOpenSession?: (id: string, projectId: number) => void;
  onImport: () => void;
  onRefresh: () => void;
}

interface UseProjectSelect {
  selectMode: boolean;
  isSelected: (id: number | string) => boolean;
  toggle: (id: number | string) => void;
  enterSelect: () => void;
  exitSelect: () => void;
  selectedCount: number;
  allSelected: boolean;
  confirming: boolean;
  syncing: boolean;
  removing: boolean;
  selectAllOrClear: () => void;
  requestRemove: () => void;
  cancelConfirm: () => void;
  syncSelected: () => void;
  removeSelected: () => void;
}

// Project-level mirror of `useSessionSelect` (src/SessionSelect.tsx) — same
// state shape (select mode, inline two-step confirm, danger action), but
// simpler: `api.deleteProject` has no undo path (it hard-deletes the project
// row, unlike a session's tombstone-based delete), so there's no Undo toast
// here, matching the existing single-project `ProjectMenu` remove flow above
// (also confirm-then-gone, no undo). Task 19, PR-2 checkpoint: "I want a
// convenient way for the user to select multiple projects... and be able to
// delete them or sync with them" (Chi). PR-2c (Task 20, chrome-sidebar
// redesign): this used to build its own boxed `.select-toolbar` `Bar` JSX;
// now it returns primitives only — ProjectsPage renders them into the ONE
// shared full-width command bar alongside the session-select flow, and
// `onBeforeEnter` lets that command bar force-exit the sibling session-select
// so at most one select mode is ever active.
function useProjectSelect(projects: ProjectSummary[], onRefresh: () => void, onBeforeEnter?: () => void): UseProjectSelect {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number | string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);

  function exitSelect() { setSelectMode(false); setSelected(new Set()); setConfirming(false); }
  function enterSelect() { onBeforeEnter?.(); setSelectMode(true); }
  function toggle(id: number | string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  // Sequential per project (brief: "immediate, spinner, sequential per
  // project") rather than Promise.all — a burst of concurrent sync requests
  // would otherwise hammer the same git/import machinery at once.
  async function syncSelected() {
    if (syncing || !selected.size) return;
    setSyncing(true);
    try {
      for (const id of selected) { try { await api.syncProject(id); } catch { /* per-project errors don't block the rest */ } }
      invalidateClientCache();
      onRefresh();
    } finally {
      setSyncing(false);
    }
  }

  async function removeSelected() {
    if (removing || !selected.size) return;
    setRemoving(true);
    try {
      for (const id of selected) { try { await api.deleteProject(id); } catch { /* per-project errors don't block the rest */ } }
      invalidateClientCache();
      onRefresh();
      exitSelect();
    } finally {
      setRemoving(false);
    }
  }

  const allSelected = projects.length > 0 && projects.every((p) => selected.has(p.id));

  return {
    selectMode, isSelected: (id) => selected.has(id), toggle, enterSelect, exitSelect,
    selectedCount: selected.size,
    allSelected,
    confirming,
    syncing,
    removing,
    selectAllOrClear: () => setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id))),
    requestRemove: () => setConfirming(true),
    cancelConfirm: () => setConfirming(false),
    syncSelected,
    removeSelected,
  };
}

// PR-2c (Task 20): project select-mode CONTROLS rendered into the shared
// command bar — "<N> projects selected · Select all · Cancel · ⟳ Sync (N) ·
// ⌫ Remove (N)", same two-step inline confirm as before, just no longer
// wrapped in its own boxed `.select-toolbar` (that box is gone; the command
// bar itself supplies the one shared frame for both select flows).
function ProjectCommandBarControls({ api }: { api: UseProjectSelect }) {
  if (api.confirming) {
    return (
      <>
        <span className="muted small">{t('Remove these from Chronicle? Source logs and folders are not touched.')}</span>
        <button className="btn ghost" onClick={api.cancelConfirm} disabled={api.removing}>{t('Cancel')}</button>
        <button className="btn danger-btn" disabled={api.removing} onClick={api.removeSelected}>
          {api.removing ? t('Removing…') : `⌫ ${t('Remove')} (${api.selectedCount})`}
        </button>
      </>
    );
  }
  return (
    <>
      <span className="muted small">{api.selectedCount} {t('projects selected')}</span>
      <button className="btn ghost" onClick={api.selectAllOrClear}>{api.allSelected ? t('Clear') : t('Select all')}</button>
      <button className="btn ghost" onClick={api.exitSelect}>{t('Cancel')}</button>
      <button className="btn ghost" disabled={!api.selectedCount || api.syncing} onClick={api.syncSelected}>
        {api.syncing ? `◌ ${t('Syncing…')}` : `⟳ ${t('Sync')} (${api.selectedCount})`}
      </button>
      <button className="btn danger-btn" disabled={!api.selectedCount} onClick={api.requestRemove}>
        ⌫ {t('Remove')} ({api.selectedCount})
      </button>
    </>
  );
}

// `/projects` — PR-2c chrome-sidebar redesign (Task 20, D14: Chi's second
// checkpoint reply). Supersedes the PR-2 two-column "card-ish rail" shape:
// "recent sessions and projects should not be seen as exactly at the same
// data model level… the old design of adding projects as a sidebar on the
// right side, similar to the left-side home sidebar" (Chi) — she picked the
// CHROME SIDEBAR mockup. Three vertical zones: the left app sidebar
// (App.tsx, untouched), a CENTER content column (`.projects-content` — filter
// toolbar, the command bar when selecting, "Recent sessions" + one small
// Select button, the ledger table; scrolls independently), and a RIGHT chrome
// sidebar (`.right-rail` — same background tone as the left app sidebar,
// full height, flush to the window edge; eyebrow `PROJECTS · N` + one small
// Select affordance; borderless `.rail-proj` nav rows — pdot · name ·
// live-dot … count · gear-visible-at-rest — meta line beneath; NO card
// borders, NO table headers — navigation, not a table). `RecentLedger` still
// owns the ledger's own data (day groups, infinite scroll, minor bucket)
// verbatim; only its select-mode CONTROLS now portal into the shared command
// bar below (see RecentLedger.tsx's `commandBarSlot`/`onSelectModeChange`/
// `onBeforeEnterSelect`/`onExposeExit`).
//
// Select mode (either list) collapses to ONE full-width command bar sliding
// in directly under the filter toolbar, in the content column — the old
// in-ledger boxed toolbar and the old in-rail boxed toolbar are both gone.
// The two select flows are mutually exclusive (entering one exits the
// other), so the bar only ever shows one at a time. "Select minor sessions
// (N)" left the ledger's resting header — it's now a chip inside the
// session command bar, sessions-only. Selected rows read as checkbox +
// subtle tint (`.row.selected`/`.rail-proj.selected` in styles.css) — no
// heavy brass border.
//
// Reflow (`styles.css` `.projects-page` @media 1100px): below 1100px the
// right sidebar leaves the chrome and renders as a boxed "Projects" section
// BELOW the ledger (ledger stays first, per D1/D13) — `.projects-page`
// itself is the single scroll container at that width, same as before.
//
// Sign-off: per Chi, 2026-08-14 second checkpoint reply (D14,
// records/plans/2026-08-14-chronicle-feedback-round-plan.md) — see
// .claude/product-contract.md for the checkable enumerable shape.
export default function ProjectsPage({ projects, onOpenProject, onOpenSession, onImport, onRefresh }: ProjectsPageProps) {
  const projectColors = useMemo(() => projectColorMap(projects?.map((p) => p.id) ?? []), [projects]);
  const [query, setQuery] = useState('');
  // Whether RecentLedger's OWN select mode is active — published up via
  // `onSelectModeChange` (RecentLedger owns the actual state; this is just
  // the boolean this component needs to decide whether the command bar is
  // visible and which flow it hosts).
  const [sessionSelectActive, setSessionSelectActive] = useState(false);
  // A stable wrapper around RecentLedger's `exitSelect`, registered once via
  // `onExposeExit` (see RecentLedger.tsx) — lets the project-select flow
  // force-close the session-select flow when it enters (mutual exclusion).
  const exitSessionSelectRef = useRef<() => void>(() => {});
  const projSelect = useProjectSelect(projects ?? [], onRefresh, () => exitSessionSelectRef.current());
  // Portal target for the session-select command-bar controls (RecentLedger
  // renders its `SessionCommandBarControls` into this node) — a callback ref
  // so the portal can start working the instant the node mounts.
  const [cmdBarSlot, setCmdBarSlot] = useState<HTMLDivElement | null>(null);

  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) return <WelcomeEmpty onImport={onImport} />;

  const showCommandBar = sessionSelectActive || projSelect.selectMode;

  return (
    <div className="page projects-page">
      <div className="projects-shell">
        <div className="projects-content">
          {/* Filter toolbar sits at the top of the CONTENT column only (Task
              20, D14 — spans the content width, NOT under the right-sidebar
              chrome; supersedes the PR-2 "spans both columns" shape now that
              the right rail is full-bleed chrome rather than a second
              content column). */}
          <div className="home-search">
            ⌕ <input placeholder={t('Filter sessions… (title, project, content)')} value={query}
              onChange={(e) => setQuery(e.target.value)} />
            <span className="kbd">⌘K</span>
          </div>
          {showCommandBar && (
            <div className="command-bar">
              {projSelect.selectMode
                ? <ProjectCommandBarControls api={projSelect} />
                : <div ref={setCmdBarSlot} className="command-bar-slot" />}
            </div>
          )}
          <RecentLedger projects={projects} onOpenSession={onOpenSession} onRefresh={onRefresh} query={query}
            commandBarSlot={cmdBarSlot}
            onSelectModeChange={setSessionSelectActive}
            onBeforeEnterSelect={() => projSelect.exitSelect()}
            onExposeExit={(fn) => { exitSessionSelectRef.current = fn; }} />
        </div>
        <aside className="right-rail">
          <div className="right-rail-head">
            <span className="eyebrow">{t('Projects')} · {projects.length}</span>
            {!projSelect.selectMode && (
              <button className="btn tiny ghost" onClick={projSelect.enterSelect}>☑ {t('Select')}</button>
            )}
          </div>
          <div className="projects-list">
            {projects.map((p) => (
              <div key={p.id}
                className={`rail-proj ${projSelect.selectMode ? 'selectable' : ''} ${projSelect.isSelected(p.id) ? 'selected' : ''}`}
                onClick={() => (projSelect.selectMode ? projSelect.toggle(p.id) : onOpenProject(p.id))}>
                <div className="rail-proj-row">
                  {projSelect.selectMode && (
                    <div className="rowcheck" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={projSelect.isSelected(p.id)}
                        onChange={() => projSelect.toggle(p.id)} aria-label={t('Select project')} />
                    </div>
                  )}
                  <div className="rail-proj-main">
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
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
