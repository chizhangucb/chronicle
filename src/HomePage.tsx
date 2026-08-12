import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from './api.js';
import { t } from './i18n.js';
import { useSessionSelect } from './SessionSelect.js';
import { sessionDisplayName } from './ProjectDetail.js';
import { useSyncStatus } from './useSyncStatus.js';
import { formatRelativeTime } from './relativeTime.js';
import { projectColorMap } from './colors.js';
import { costOf, type ModelUsageInput } from './models.js';
import { fmtDur } from './session/stats.js';
import { fmtMoney, pluralize } from './format.js';
import { useResizable } from './useResizable.ts';
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

interface ProjectMenuProps {
  project: ProjectSummary;
  onOpenProject: (id: number | string) => void;
  onRefresh: () => void;
}

function ProjectMenu({ project, onOpenProject, onRefresh }: ProjectMenuProps) {
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Remove is gated by an INLINE two-step confirm inside the dropdown, not
  // `window.confirm` — window.confirm/alert/prompt silently no-op in
  // embedded/preview browser contexts (see CLAUDE.md), which is exactly why
  // Home's old project multi-select delete and OverviewMode's rename both use
  // an inline affordance instead. `open` is controlled so the confirm state
  // resets whenever the dropdown closes (click-away, Escape, etc.), not just
  // on an explicit Cancel click.
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Inline rename + inline error — never window.prompt/alert, which silently
  // no-op in embedded/preview browsers (see CLAUDE.md). Mirrors OverviewMode's
  // edit-in-place and the confirmRemove two-step below.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(action: 'sync' | 'details' | 'remove') {
    setErr(null);
    try {
      if (action === 'sync') {
        setSyncing(true);
        await api.syncProject(project.id);
        onRefresh();
      } else if (action === 'details') {
        onOpenProject(project.id);
      } else if (action === 'remove') {
        setRemoving(true);
        await api.deleteProject(project.id);
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
    if (!name) { setRenaming(false); return; } // blank cancels (folder name required)
    setErr(null);
    setSavingName(true);
    try { await api.renameProject(project.id, name); setRenaming(false); setOpen(false); onRefresh(); }
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
                    {removing ? t('Removing…') : `🗑 ${t('Remove')}`}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <DropdownMenu.Item className="menu-item" onSelect={() => run('sync')}>⟳ {t('Sync Update')}</DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => run('details')}>ⓘ {t('View Details')}</DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={(e) => { e.preventDefault(); setNameDraft(project.name); setErr(null); setRenaming(true); }}>✎ {t('Rename')}</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item danger" onSelect={(e) => { e.preventDefault(); setConfirmRemove(true); }}>
                  🗑 {t('Remove from Chronicle')}
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

export interface HomePageProps {
  projects: ProjectSummary[] | null;
  onOpenProject: (id: number | string) => void;
  onOpenSession?: (id: string, projectId: number) => void;
  onImport: () => void;
  onRefresh: () => void;
}

// The empty-query "recent" branch of GET /api/search returns this many rows
// per page; a short page (< RECENT_PAGE) means there is nothing left to
// lazy-load. Kept in sync with `LIMIT 50` in server/routes/search.ts.
const RECENT_PAGE = 50;

// ---- Ledger row helpers (local, trivial — not shared/tested) ----

// Per-row cost: aggregates the row's `usage` blob (per-model token totals,
// only populated on the empty-query "recent" branch of GET /api/search — see
// server/routes/search.ts) the same way OverviewMode/ProjectDetail's
// sessionCost() already do, just reading it off a search-result row instead
// of the full session object.
function rowCost(s: SearchResultItem): number | null {
  if (!s.usage) return null;
  try {
    const usage = JSON.parse(s.usage) as Record<string, ModelUsageInput> | null;
    if (!usage) return null;
    const costs = Object.entries(usage).map(([m, u]) => costOf(m, u)).filter((c): c is number => c != null);
    return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  } catch { return null; }
}

function costLabel(s: SearchResultItem): string {
  const c = rowCost(s);
  return c == null ? '—' : `$${c.toFixed(2)}`;
}

function activeLabel(s: SearchResultItem): string {
  return fmtDur(s.agent_active_ms);
}

// `message_count` is only populated on the empty-query "recent" branch of
// /api/search — the FTS/LIKE match branch doesn't select it, so it's
// `undefined` there. Render '—' (matching the Cost/Active placeholder) rather
// than a false "0" for search-mode rows.
function msgsLabel(s: SearchResultItem): string {
  return s.message_count != null ? String(s.message_count) : '—';
}

// Always an ABSOLUTE local timestamp — `MMM D HH:MM` 24-hour (e.g. `Aug 11
// 23:47`). Relative time ("2h ago") is ambiguous once a day-head already
// groups by calendar day, so the When column is always a fixed clock stamp.
const WHEN_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
function whenLabel(s: SearchResultItem): string {
  if (!s.ts) return '';
  const d = new Date(s.ts);
  if (Number.isNaN(d.getTime())) return '';
  // en-US month/day/24h formatting; strip the ", " between date and time to
  // read `Aug 11 23:47` rather than `Aug 11, 23:47`.
  return WHEN_FMT.format(d).replace(', ', ' ');
}

interface DayGroup {
  label: string;
  // `cost` is null (not 0) when none of the group's rows carry priced usage
  // data — e.g. every row came from the FTS/LIKE search branch of
  // /api/search, which doesn't select `usage` at all. A real $0.00 (priced
  // usage that happens to sum to zero) is distinguished from "we don't know"
  // by checking `rowCost` per row rather than defaulting to 0.
  sum: { count: number; cost: number | null } | null;
  rows: SearchResultItem[];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 'Today' / 'Yesterday' / 'Ddd · Mon D' for older days. `diffDays` is computed
// by the caller and passed in so the Today/Yesterday branch keys off the same
// day-diff math, not a comparison against the (locale-translated) label string
// (which would silently break for zh/ja).
function dayLabel(d: Date, diffDays: number): string {
  if (diffDays === 0) return t('Today');
  if (diffDays === 1) return t('Yesterday');
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const month = d.toLocaleDateString(undefined, { month: 'short' });
  return `${weekday} · ${month} ${d.getDate()}`;
}

// Groups already-sorted-by-recency search rows by local calendar day,
// preserving the incoming order (server sorts by ts DESC on both the
// empty-query and FTS branches of /api/search).
function groupByDay(sessions: SearchResultItem[]): DayGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, { date: Date; rows: SearchResultItem[] }>();
  for (const s of sessions) {
    const raw = s.ts ? new Date(s.ts) : null;
    const date = raw && !Number.isNaN(raw.getTime()) ? raw : new Date(0);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { date, rows: [] };
      byKey.set(key, entry);
      order.push(key);
    }
    entry.rows.push(s);
  }
  const today = startOfDay(new Date());
  return order.map((key) => {
    const { date, rows } = byKey.get(key) as { date: Date; rows: SearchResultItem[] };
    const diffDays = Math.round((today - startOfDay(date)) / 86400000);
    const pricedCosts = rows.map(rowCost).filter((c): c is number => c != null);
    const cost = pricedCosts.length ? pricedCosts.reduce((a, b) => a + b, 0) : null;
    return { label: dayLabel(date, diffDays), sum: { count: rows.length, cost }, rows };
  });
}

export default function HomePage({ projects, onOpenProject, onOpenSession, onImport, onRefresh }: HomePageProps) {
  // Recent-sessions stream: reuses GET /api/search's empty-query "recent"
  // mode (already excludes minor/gated sessions — see server/routes/search.ts),
  // mounting the SAME shared session multi-select delete component as the
  // project session list (see src/SessionSelect.tsx). A non-empty `query`
  // switches to the same endpoint's FTS/LIKE match mode (⌘K's SearchModal
  // hits the identical endpoint).
  const [recentSessions, setRecentSessions] = useState<SearchResultItem[] | null>(null);
  // Monotonic request-id guard: the debounce alone only collapses RAPID
  // keystrokes into one fetch — it does nothing once two fetches are already
  // in flight (e.g. "abc" fires, then "abcd" fires before "abc"'s response
  // lands; or a query fires, then the box is cleared before it lands). Each
  // fetch captures the id current AT FIRE TIME and only applies its result if
  // that id is still the latest by the time it resolves, so an out-of-order
  // response can never clobber a newer one.
  const requestId = useRef(0);
  // `hasMore` gates the lazy-scroll sentinel: a full page (=== RECENT_PAGE)
  // means there may be more to load; a short page ends pagination.
  const [hasMore, setHasMore] = useState(true);
  const loadingMore = useRef(false);
  const refreshRecent = () => {
    const id = ++requestId.current;
    loadingMore.current = false;
    api.search({}).then((r) => {
      if (id !== requestId.current) return;
      setRecentSessions(r.results);
      setHasMore(r.results.length === RECENT_PAGE);
    }).catch(() => { if (id === requestId.current) { setRecentSessions([]); setHasMore(false); } });
  };
  useEffect(() => { refreshRecent(); }, []);

  const [query, setQuery] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  function handleQueryChange(next: string) {
    setQuery(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const trimmed = next.trim();
      if (!trimmed) { refreshRecent(); return; }
      const id = ++requestId.current;
      api.search({ q: trimmed }).then((r) => { if (id === requestId.current) setRecentSessions(r.results); })
        .catch(() => { if (id === requestId.current) setRecentSessions([]); });
    }, 200);
  }

  // Lazy-scroll: append the next page of recent sessions when the sentinel at
  // the ledger bottom scrolls into view. Only in "recent" mode (empty query) —
  // the FTS/LIKE search branch isn't paginated. New rows are deduped by id
  // against what's already loaded, so a re-fetch or a session landing between
  // pages can never double-render. `requestId` guards against a refresh/search
  // superseding an in-flight append.
  const isRecentMode = !query.trim();
  function loadMore() {
    if (loadingMore.current || !hasMore || !isRecentMode || recentSessions == null) return;
    loadingMore.current = true;
    const id = requestId.current;
    const offset = recentSessions.length;
    api.search({ offset }).then((r) => {
      loadingMore.current = false;
      if (id !== requestId.current) return;
      setRecentSessions((prev) => {
        const base = prev ?? [];
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...r.results.filter((x) => !seen.has(x.id))];
      });
      setHasMore(r.results.length === RECENT_PAGE);
    }).catch(() => { loadingMore.current = false; });
  }
  // Keep the observer callback pointed at the latest closure (state changes each
  // render) without tearing down/rebuilding the observer on every keystroke.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isRecentMode || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMoreRef.current();
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
    // Re-observe after each append so a still-visible sentinel triggers the
    // next page (a continuously-intersecting target won't re-fire on its own).
  }, [isRecentMode, hasMore, recentSessions]);

  const selectableRecent = (recentSessions ?? []).map((s) => ({ id: s.id, source: s.source, project_id: s.project_id }));
  const recentSelect = useSessionSelect(selectableRecent, () => { refreshRecent(); onRefresh(); });

  // Passive (button-free) sync-status indicator (5d-0) + stable per-project
  // identity color (5c), reused for both the rail rows and the ledger's
  // project pills.
  const sync = useSyncStatus();
  const projectColors = useMemo(() => projectColorMap(projects?.map((p) => p.id) ?? []), [projects]);
  const groups = useMemo(() => groupByDay(recentSessions ?? []), [recentSessions]);

  // Drag-to-resize width for the right project rail (persisted). The handle
  // sits on the rail's LEFT edge, so the rail grows as the cursor moves left.
  const rail = useResizable({ storageKey: 'chronicle.railW', fallback: 280, min: 220, max: 480, edge: 'left' });

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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="home-body">
        <main className="home-stream">
          <div className="home-search">
            ⌕ <input placeholder={t('Filter sessions… (title, project, content)')} value={query}
              onChange={(e) => handleQueryChange(e.target.value)} />
            <span className="kbd">⌘K</span>
          </div>
          <div className="page-title-row">
            <h1 className="page-title">{t('Recent sessions')}</h1>
            <div className="page-title-actions">
              <span className="muted">{pluralize(projects?.length ?? 0, t('project'), t('projects'))}</span>
              {recentSelect.Bar}
            </div>
          </div>
          <div className={`colhead ${recentSelect.selectMode ? 'selectable' : ''}`}>
            {recentSelect.selectMode && <span aria-hidden="true" />}
            <span>{t('Session')}</span><span>{t('Project')}</span><span>{t('Cost')}</span>
            <span>{t('Active')}</span><span>{t('Msgs')}</span><span>{t('When')}</span>
          </div>
          {groups.map((g) => (
            <section className="day" key={g.label}>
              <div className="day-head"><span className="d">{g.label}</span>
                {g.sum && (
                  <span className="sum">
                    {pluralize(g.sum.count, t('session'), t('sessions'))}{g.sum.cost != null && ` · ${fmtMoney(g.sum.cost, 2)}`}
                  </span>
                )}</div>
              {g.rows.map((s) => (
                <div key={s.id} className={`row ${recentSelect.selectMode ? 'selectable' : ''} ${recentSelect.isSelected(s.id) ? 'selected' : ''}`}
                  onClick={() => (recentSelect.selectMode ? recentSelect.toggle(s.id) : onOpenSession?.(s.id, s.project_id))}>
                  {recentSelect.selectMode && (
                    <div className="rowcheck" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={recentSelect.isSelected(s.id)}
                        onChange={() => recentSelect.toggle(s.id)} aria-label={t('Select session')} />
                    </div>
                  )}
                  <div className="title"><div className="t">{sessionDisplayName(s)}</div>
                    <div className="sub"><span className="pill src-pill">{s.source}</span></div></div>
                  <div className="m"><span className="pill proj" style={{ '--project-color': projectColors.get(s.project_id) } as React.CSSProperties}>{s.project_name}</span></div>
                  <div className="m"><b>{costLabel(s)}</b></div>
                  <div className="m">{activeLabel(s)}</div>
                  <div className="m"><b>{msgsLabel(s)}</b></div>
                  <div className="m">{whenLabel(s)}</div>
                </div>
              ))}
            </section>
          ))}
          {isRecentMode && hasMore && <div ref={sentinelRef} className="ledger-sentinel" aria-hidden="true" />}
          <MinorSessionsBucket onRefresh={onRefresh} />
        </main>
        <div className="drag-handle" role="separator" aria-orientation="vertical"
          aria-label={t('Resize projects panel')} onPointerDown={rail.onHandlePointerDown} />
        <aside className="home-rail" style={{ width: rail.width }}>
          <div className="rail-head">
            <span className="eyebrow">{t('Projects')}</span>
            <span className={`sync ${sync.running ? 'running' : ''} ${sync.failed ? 'failed' : ''}`}>{sync.text}</span>
          </div>
          {(projects ?? []).map((p) => (
            <div key={p.id} className="rail-proj" onClick={() => onOpenProject(p.id)}>
              <div className="n">
                <span><span className="pdot" style={{ background: projectColors.get(p.id) ?? 'var(--ink-3)' }} />{p.name}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="c num">{p.session_count}</span>
                  <ProjectMenu project={p} onOpenProject={onOpenProject} onRefresh={onRefresh} />
                </span>
              </div>
              <div className="meta">
                {p.git?.isRepo ? <span className="git">⎇ {p.git.branch}</span> : <span>{t('needs association')}</span>}
                {p.last_active && <><span>·</span><span>{formatRelativeTime(p.last_active)}</span></>}
              </div>
            </div>
          ))}
        </aside>
      </div>
      {recentSelect.Toast}
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
