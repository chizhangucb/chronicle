import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { t } from './i18n.js';
import { useSessionSelect, type UseSessionSelect } from './SessionSelect.js';
import { sessionDisplayName } from './ProjectDetail.js';
import InfoTip from './InfoTip.js';
import { projectColorMap } from './colors.js';
import { costOf, type ModelUsageInput } from './models.js';
import { fmtDur } from './session/stats.js';
import { fmtMoney, pluralize } from './format.js';
import type { SearchResultItem } from './api.js';
import type { ProjectSummary } from './ProjectsPage.js';

// The recent-sessions ledger, extracted from the old HomePage (Task 13) so it
// can be reused verbatim as the LAST section of the new `/` dashboard while
// staying the body of `/projects` too — same search box, day-grouping, lazy
// infinite scroll, and multi-select delete. Nothing here forked: the previous
// HomePage inlined all of this.

// The empty-query "recent" branch of GET /api/search returns this many rows
// per page; a short page (< RECENT_PAGE) means there is nothing left to
// lazy-load. Kept in sync with `LIMIT 50` in server/routes/search.ts.
const RECENT_PAGE = 50;

// ---- Ledger row helpers (local, trivial — not shared/tested) ----

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
  return c == null ? '—' : fmtMoney(c, 2);
}

function activeLabel(s: SearchResultItem): string {
  return fmtDur(s.agent_active_ms);
}

function msgsLabel(s: SearchResultItem): string {
  return s.message_count != null ? String(s.message_count) : '—';
}

const WHEN_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
function whenLabel(s: SearchResultItem): string {
  if (!s.ts) return '';
  const d = new Date(s.ts);
  if (Number.isNaN(d.getTime())) return '';
  return WHEN_FMT.format(d);
}

interface DayGroup {
  label: string;
  sum: { count: number; cost: number | null } | null;
  rows: SearchResultItem[];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(d: Date, diffDays: number): string {
  if (diffDays === 0) return t('Today');
  if (diffDays === 1) return t('Yesterday');
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const month = d.toLocaleDateString(undefined, { month: 'short' });
  return `${weekday} · ${month} ${d.getDate()}`;
}

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

export interface RecentLedgerProps {
  projects: ProjectSummary[] | null;
  onOpenSession?: (id: string, projectId: number) => void;
  onRefresh: () => void;
  // Filter query (Task 19, PR-2 checkpoint): `/projects` lifts the filter box
  // out into a full-width toolbar that spans the content column, so IT owns
  // the input + its own state and passes the live value down here — the
  // ledger's own `.home-search` box is suppressed and the debounced-search
  // effect below just reacts to the prop instead of local state. `/projects`
  // is RecentLedger's only mount point (Task 20, PR-2c — the old standalone
  // `/` HomeDashboard mount was already gone before this task), so `query`
  // is unconditionally controlled — no uncontrolled fallback branch needed.
  query: string;
  // PR-2c chrome-sidebar redesign (Task 20): the old in-ledger boxed
  // `.select-toolbar` is gone — session select-mode CONTROLS portal into a
  // DOM node ProjectsPage owns (the shared full-width command bar, directly
  // under the filter toolbar), so both the session and project select flows
  // render through the SAME bar instead of two separate boxed toolbars.
  // `commandBarSlot` is that portal target; `onSelectModeChange` publishes
  // this ledger's selectMode boolean up (so ProjectsPage knows whether to
  // show the command bar at all); `onBeforeEnterSelect` lets ProjectsPage
  // force-exit the SIBLING project-select flow so at most one is ever active;
  // `onExposeExit` registers a stable exit function once, so the project
  // select flow (entered from the right rail) can close this one out too.
  commandBarSlot?: HTMLElement | null;
  onSelectModeChange?: (active: boolean) => void;
  onBeforeEnterSelect?: () => void;
  onExposeExit?: (fn: () => void) => void;
}

export default function RecentLedger({ projects, onOpenSession, onRefresh, query, commandBarSlot, onSelectModeChange, onBeforeEnterSelect, onExposeExit }: RecentLedgerProps) {
  const [recentSessions, setRecentSessions] = useState<SearchResultItem[] | null>(null);
  const requestId = useRef(0);
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

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  // Fires the debounced search whenever the controlled `query` prop changes —
  // skips the very first mount (the effect above already covers the
  // empty-query initial fetch).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const trimmed = query.trim();
      if (!trimmed) { refreshRecent(); return; }
      const id = ++requestId.current;
      api.search({ q: trimmed }).then((r) => { if (id === requestId.current) setRecentSessions(r.results); })
        .catch(() => { if (id === requestId.current) setRecentSessions([]); });
    }, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

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
  }, [isRecentMode, hasMore, recentSessions]);

  const selectableRecent = (recentSessions ?? []).map((s) => ({ id: s.id, source: s.source, project_id: s.project_id }));
  const recentSelect = useSessionSelect(selectableRecent, () => { refreshRecent(); onRefresh(); }, undefined,
    { onBeforeEnter: onBeforeEnterSelect });

  const projectColors = useMemo(() => projectColorMap(projects?.map((p) => p.id) ?? []), [projects]);
  const groups = useMemo(() => groupByDay(recentSessions ?? []), [recentSessions]);

  // Minor (noise-gated) sessions never appear in `recentSessions` above (the
  // "recent" search branch excludes them — server/routes/search.ts), so the
  // count lives up here too: it drives BOTH the "Select minor sessions"
  // quick-select chip (now IN the command bar, sessions-only — see PR-2c
  // below) and the top-of-ledger notice (below), off one shared fetch/refresh.
  const [minorItems, setMinorItems] = useState<MinorSession[] | null>(null);
  const loadMinor = () => api.minorSessions().then(setMinorItems).catch(() => setMinorItems([]));
  useEffect(() => { loadMinor(); }, []);

  // The minor-sessions surface is a single INLINE panel at the top of the
  // ledger (not a permanent section at the bottom): "Show them" expands the
  // list in place — no long scroll, nothing hanging below. Without a visible
  // notice, gated sessions read as "missing" and the product looks broken
  // (they aren't — they synced; the noise gate just parked them).
  const [minorOpen, setMinorOpen] = useState(false);

  function selectMinorSessions() {
    if (!minorItems || !minorItems.length) return;
    if (!recentSelect.selectMode) recentSelect.enterSelect();
    recentSelect.setMany(minorItems.map((m) => m.id), true);
  }

  // Publish selectMode up (ProjectsPage needs this boolean to decide whether
  // the shared command bar is visible at all) and register a stable exit
  // function once (so entering the SIBLING project-select flow, which lives
  // entirely in ProjectsPage, can close this one — see SessionSelect.tsx's
  // `onBeforeEnter` for the reverse direction). `exitRef` mirrors the
  // existing `loadMoreRef` pattern above: keep a ref pointed at the latest
  // closure, expose a stable wrapper that always calls through it.
  //
  // Task 20 review, traced + fixed: switching project-select -> session-select
  // used to unmount and remount the shared `.command-bar` (replaying its
  // entrance animation), because `showCommandBar` in ProjectsPage
  // (`sessionSelectActive || projSelect.selectMode`) briefly computed FALSE
  // mid-switch. `projSelect.selectMode` flips false SYNCHRONOUSLY (inside
  // `recentSelect.enterSelect()` below, via `onBeforeEnterSelect`), but
  // `sessionSelectActive` — the mirror of THIS ledger's `recentSelect.
  // selectMode` — used to only update via an effect watching it AFTER the
  // fact. Switching that effect from `useEffect` to `useLayoutEffect` was
  // NOT enough: React had already committed a real DOM mutation removing
  // `.command-bar` in the FIRST commit (the one containing the click's own
  // batched state updates), and re-adding it in a SECOND commit (triggered
  // by the layout effect) creates a genuinely NEW DOM node — proven by a
  // Playwright check that marks the live node and confirms identity survives
  // (test/e2e/projects.spec.ts). Flushing both commits before paint hides it
  // from the human eye but does not stop the browser from starting the CSS
  // entrance animation over on the replacement node.
  //
  // The actual fix: notify `onSelectModeChange` SYNCHRONOUSLY, inside the
  // SAME click handler that flips `recentSelect.selectMode` (`handleEnter`
  // below), so `sessionSelectActive` and `projSelect.selectMode` land in the
  // exact same React batch/commit as each other — `showCommandBar` never
  // computes false at any point, so React's reconciler sees the SAME
  // `.command-bar` position true-before/true-after and reuses the same DOM
  // node (only its portaled CHILD content swaps). The reverse direction
  // (session -> project) never needed this: `projSelect.selectMode` itself
  // flips true in the very same synchronous commit that flips
  // `recentSelect.selectMode` false (both owned/triggered directly in
  // ProjectsPage), so the OR is already satisfied without any round-trip.
  // The `useLayoutEffect` stays as a general safety net (e.g. a completed
  // Remove exits select mode from inside the hook's own async delete flow,
  // not from a RecentLedger click handler) — redundant-but-harmless on the
  // paths `handleEnter` already covers synchronously (same value, no-op).
  useLayoutEffect(() => { onSelectModeChange?.(recentSelect.selectMode); }, [recentSelect.selectMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const exitRef = useRef(recentSelect.exitSelect);
  exitRef.current = recentSelect.exitSelect;
  useEffect(() => { onExposeExit?.(() => exitRef.current()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEnterSelect() {
    onSelectModeChange?.(true);
    recentSelect.enterSelect();
  }

  return (
    <section className="recent-ledger">
      {recentSelect.selectMode && commandBarSlot && createPortal(
        <SessionCommandBarControls api={recentSelect} minorCount={minorItems?.length ?? 0} onSelectMinor={selectMinorSessions} />,
        commandBarSlot,
      )}
      <div className="page-title-row">
        <h2 className="page-title">{t('Recent sessions')}</h2>
        {!recentSelect.selectMode && (
          <div className="page-title-actions">
            <button className="btn small" onClick={handleEnterSelect}>☑ {t('Select')}</button>
          </div>
        )}
      </div>
      {isRecentMode && (minorItems?.length ?? 0) > 0 && (
        <MinorSessionsNotice items={minorItems} open={minorOpen} setOpen={setMinorOpen}
          onRefresh={() => { loadMinor(); onRefresh(); }} />
      )}
      <div className={`colhead ${recentSelect.selectMode ? 'selectable' : ''}`}>
        {recentSelect.selectMode && <span aria-hidden="true" />}
        <span>{t('Session')}</span><span>{t('Project')}</span><span className="num-col">{t('Cost')}</span>
        <span className="num-col">{t('Active')}</span><span className="num-col">{t('Msgs')}</span><span className="ts-col">{t('When')}</span>
      </div>
      {groups.map((g) => {
        const ids = g.rows.map((r) => r.id);
        const selectedCount = ids.filter((id) => recentSelect.isSelected(id)).length;
        const dayAllSelected = ids.length > 0 && selectedCount === ids.length;
        const dayIndeterminate = selectedCount > 0 && !dayAllSelected;
        return (
          <section className="day" key={g.label}>
            <div className="day-head">
              {recentSelect.selectMode && (
                <label className="daycheck" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={dayAllSelected}
                    ref={(el) => { if (el) el.indeterminate = dayIndeterminate; }}
                    onChange={() => recentSelect.setMany(ids, !dayAllSelected)}
                    aria-label={`${t('Select')} ${g.label}`} />
                </label>
              )}
              <span className="d">{g.label}</span>
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
                <div className="title"><div className="t" title={sessionDisplayName(s)}>{sessionDisplayName(s)}</div>
                  <div className="sub"><span className="pill src-pill">{s.source}</span></div></div>
                <div className="m"><span className="pill proj" style={{ '--project-color': projectColors.get(s.project_id) } as React.CSSProperties}>{s.project_name}</span></div>
                <div className="m num-col"><b>{costLabel(s)}</b></div>
                <div className="m num-col">{activeLabel(s)}</div>
                <div className="m num-col"><b>{msgsLabel(s)}</b></div>
                <div className="m ts-col">{whenLabel(s)}</div>
              </div>
            ))}
          </section>
        );
      })}
      {isRecentMode && hasMore && <div ref={sentinelRef} className="ledger-sentinel" aria-hidden="true" />}
      {recentSelect.Toast}
    </section>
  );
}

// PR-2c (Task 20): session select-mode CONTROLS, portaled into ProjectsPage's
// shared `.command-bar` slot instead of RecentLedger's own boxed toolbar —
// "<N> sessions selected · Select all · Cancel · [minor chip, sessions-only]
// · ⌫ Remove (N)", with the SAME two-step inline confirm + undo-toast flow
// `useSessionSelect` has always driven (built from the primitives it now
// exposes — see SessionSelect.tsx — not a re-implementation).
function SessionCommandBarControls({ api, minorCount, onSelectMinor }: { api: UseSessionSelect; minorCount: number; onSelectMinor: () => void }) {
  if (api.confirming) {
    return (
      <>
        <span className="muted small">{t('Remove these sessions from Chronicle? Source logs are not touched — you can undo right after.')}</span>
        <button className="btn ghost" onClick={api.cancelConfirm} disabled={api.deleting}>{t('Cancel')}</button>
        <button className="btn danger-btn" onClick={api.confirmRemove} disabled={api.deleting}>
          {api.deleting ? t('Removing…') : `⌫ ${t('Remove')} ${api.selectedCount}`}
        </button>
      </>
    );
  }
  return (
    <>
      <span className="muted small">{api.selectedCount} {t('sessions selected')}</span>
      <button className="btn ghost" onClick={api.selectAllOrClear}>{api.allVisibleSelected ? t('Clear') : t('Select all')}</button>
      <button className="btn ghost" onClick={api.exitSelect}>{t('Cancel')}</button>
      {minorCount > 0 && (
        <button className="chip minor-quick-select" onClick={onSelectMinor}>
          {t('Select minor sessions')} ({minorCount})
        </button>
      )}
      <button className="btn danger-btn" disabled={!api.selectedCount} onClick={api.requestRemove}>
        ⌫ {t('Remove')}{api.selectedCount ? ` (${api.selectedCount})` : ''}
      </button>
    </>
  );
}

// ---- Minor-sessions notice (noise gate — Phase 5 PR 5a; inline redesign) ----
// Sub-threshold sessions (short AND low-message — server/noiseGate.ts) are
// gated out of every main list at import time (server/db.ts replaceSession).
// This is the single surface where they still live: an INLINE panel at the top
// of the ledger (recent mode), collapsed by default. "Show them" expands the
// list in place — no long scroll to a bottom section, nothing hanging below.
// Promote (bring it back) / ignore (=tombstone, same as delete) per row.

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

// The exact gate definition, surfaced via an InfoTip so users understand WHY a
// session is classed minor (mirrors the AND semantics in server/noiseGate.ts).
const MINOR_DEFINITION = 'A session is “minor” only when it’s small on BOTH axes: under ~5 min of agent-active time AND fewer than 10 messages — a true one-shot. Thresholds are adjustable in Settings. Minor sessions synced fine; they’re just parked out of the main lists so they don’t clutter.';

// `items`/`open`/`onRefresh` are owned by RecentLedger (shared with the "Select
// minor sessions" quick-select in the command bar, which needs the same
// list/count). This component is the notice + inline expand/promote/ignore.
function MinorSessionsNotice({ items, open, setOpen, onRefresh }: {
  items: MinorSession[] | null;
  open: boolean;
  setOpen: (fn: (o: boolean) => boolean) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function promote(id: string) {
    setBusy(id);
    try { await api.promoteSession(id); onRefresh(); } finally { setBusy(null); }
  }
  async function ignore(id: string) {
    setBusy(id);
    try { await api.deleteSession(id); onRefresh(); } finally { setBusy(null); }
  }

  if (!items || !items.length) return null;

  return (
    <div className="callout minor-filter-notice" role="status">
      <div className="minor-notice-head">
        <button className="btn tiny ghost minor-notice-toggle" onClick={() => setOpen((o) => !o)}
          aria-expanded={open}>
          <span className="tw" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <b>{pluralize(items.length, t('session'), t('sessions'))} {t('hidden by the minor-session filter')}</b>
        </button>
        <InfoTip text={t(MINOR_DEFINITION)} />
      </div>
      {!open && (
        <div className="why">{t('Short, low-activity sessions are parked out of the main lists so they don’t clutter — they synced fine, nothing is missing.')}{' '}
          <button className="linklike" onClick={() => setOpen(() => true)}>{t('Show them')}</button>
        </div>
      )}
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
