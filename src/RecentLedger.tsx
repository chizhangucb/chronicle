import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import { useSessionSelect } from './SessionSelect.js';
import { sessionDisplayName } from './ProjectDetail.js';
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
}

export default function RecentLedger({ projects, onOpenSession, onRefresh }: RecentLedgerProps) {
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
  const recentSelect = useSessionSelect(selectableRecent, () => { refreshRecent(); onRefresh(); });

  const projectColors = useMemo(() => projectColorMap(projects?.map((p) => p.id) ?? []), [projects]);
  const groups = useMemo(() => groupByDay(recentSessions ?? []), [recentSessions]);

  return (
    <section className="recent-ledger">
      <div className="home-search">
        ⌕ <input placeholder={t('Filter sessions… (title, project, content)')} value={query}
          onChange={(e) => handleQueryChange(e.target.value)} />
        <span className="kbd">⌘K</span>
      </div>
      <div className="page-title-row">
        <h2 className="page-title">{t('Recent sessions')}</h2>
        <div className="page-title-actions">
          {recentSelect.Bar}
        </div>
      </div>
      <div className={`colhead ${recentSelect.selectMode ? 'selectable' : ''}`}>
        {recentSelect.selectMode && <span aria-hidden="true" />}
        <span>{t('Session')}</span><span>{t('Project')}</span><span className="num-col">{t('Cost')}</span>
        <span className="num-col">{t('Active')}</span><span className="num-col">{t('Msgs')}</span><span className="ts-col">{t('When')}</span>
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
              <div className="m num-col"><b>{costLabel(s)}</b></div>
              <div className="m num-col">{activeLabel(s)}</div>
              <div className="m num-col"><b>{msgsLabel(s)}</b></div>
              <div className="m ts-col">{whenLabel(s)}</div>
            </div>
          ))}
        </section>
      ))}
      {isRecentMode && hasMore && <div ref={sentinelRef} className="ledger-sentinel" aria-hidden="true" />}
      <MinorSessionsBucket onRefresh={onRefresh} />
      {recentSelect.Toast}
    </section>
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
