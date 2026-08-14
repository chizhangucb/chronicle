import React, { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLocation, useSearch } from 'wouter';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  insightsUrl, activityUrl,
  type InsightsResult, type ActivityResult, type ActivityTokensByModel, type ActivitySessionLite,
} from './api.js';
import RecentLedger from './RecentLedger.js';
import { WelcomeEmpty } from './ProjectsPage.js';
import type { ProjectSummary } from './ProjectsPage.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { costOf, type ModelUsageInput } from './models.js';
import { fmtInt, fmtMoney, pluralize } from './format.js';
import { formatRelativeTime } from './relativeTime.js';
import { t, lang } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import WorkingRhythm from './insights/WorkingRhythm.tsx';
import { CATEGORICAL_COLORS, projectColorMap } from './colors.ts';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from './charts/ChartWrapper.tsx';
import { sessionDisplayName } from './ProjectDetail.jsx';
import ExploreTab from './ExploreTab.tsx';
import ContentTab from './ContentTab.tsx';

// The ONE Insights hub at `/` (product-IA fix, 2026-08-13). Home and the old
// `/insights` page are merged into a single tabbed surface — Overview / Explore
// / Content — so there is exactly one KPI strip and one `/api/insights` fetch,
// never two pages showing the same aggregates. Overview reading order, top→
// bottom: KPI strip (with the window toggle) → Activity block (live + since-you-
// left, Today only) → Burn tile → the Insights Overview charts → Recent-sessions
// ledger LAST. Explore/Content reuse the existing tab components at scope=all.

type Tab = 'overview' | 'explore' | 'content';

// Window toggle: all five options live on this ONE surface (spec §2.2a). Today =
// fractional-days-since-local-midnight; All = no cutoff (days omitted).
type WindowKey = 'today' | '7d' | '30d' | '90d' | 'all';
const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
];
function windowDays(win: WindowKey, daysToday: number): number | null {
  switch (win) {
    case 'today': return daysToday;
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    case 'all': return null;
  }
}

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
function localeOf(): string { return INTL_LOCALE[lang()] ?? 'en-US'; }

// ---- Local formatters (shared with the old InsightsPage body). `fmtMoney`/
// `fmtInt` are the SHARED grouped money/int formatters from format.ts. ----
function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}
function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtHours(ms: number): string { return (ms / 3600000).toFixed(1); }
function fmtActive(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtDayLabel(day: string): string {
  return new Intl.DateTimeFormat(localeOf(), { month: 'short', day: 'numeric' }).format(new Date(`${day}T00:00:00Z`));
}

function parseUsage(json: string | null): Record<string, ModelUsageInput> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, ModelUsageInput>; } catch { return {}; }
}
function sessionCost(json: string | null): number {
  let total = 0;
  for (const [model, u] of Object.entries(parseUsage(json))) total += costOf(model, u) ?? 0;
  return total;
}
// "Tokens" = input + output only (matches ProjectDetail/OverviewMode); cache
// tokens are a separate billing tier shown in the token table's own columns.
function sessionTokens(json: string | null): number {
  let total = 0;
  for (const u of Object.values(parseUsage(json))) total += (u.input || 0) + (u.output || 0);
  return total;
}

// Price a bag of per-model token cells client-side (the price table lives ONLY
// in src/models.ts — hard constraint; the server returns tokens, never $).
function priceCells(byModel: ActivityTokensByModel): number {
  let total = 0;
  for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell) ?? 0;
  return total;
}

export interface HomeDashboardProps {
  projects: ProjectSummary[] | null;
  onOpenProject: (id: number | string) => void;
  onOpenSession?: (id: string, projectId: number) => void;
  onImport: () => void;
  onRefresh: () => void;
}

// localStorage key holding the last time the user left the app — sent as
// `?since=` so the Activity block can show "since you left". Written on tab
// hide / pagehide; read ONCE at mount BEFORE the writer fires, so `since`
// reflects the PREVIOUS visit, not this one.
const LAST_VISIT_KEY = 'chronicle.lastVisit';

export default function HomeDashboard({ projects, onOpenSession, onImport, onRefresh }: HomeDashboardProps): JSX.Element {
  const [, navigate] = useLocation();
  const [win, setWin] = useState<WindowKey>('today');

  // Deep-linkable tabs via a `?tab=` query param (simplest faithful option —
  // the old InsightsPage used pure local state, but `/insights?tab=explore`
  // bookmarks now redirect here and this keeps them working). Overview is the
  // bare `/` with no param.
  const search = useSearch();
  const tabParam = new URLSearchParams(search).get('tab');
  const tab: Tab = tabParam === 'explore' ? 'explore' : tabParam === 'content' ? 'content' : 'overview';
  const selectTab = (next: Tab) => navigate(next === 'overview' ? '/' : `/?tab=${next}`);

  // Fractional days since LOCAL midnight — same "Today" semantics as
  // ProjectDetail. Memoized so it's stable within a mount.
  const daysToday = useMemo(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.max((now.getTime() - midnight) / 86400000, 1 / 1440); // ≥1 min, never 0
  }, []);
  const days = windowDays(win, daysToday);
  const isToday = win === 'today';

  // Read the previous visit time once (before the unload writer overwrites it).
  const sinceRef = useRef<string | null>(null);
  if (sinceRef.current === null) sinceRef.current = localStorage.getItem(LAST_VISIT_KEY);
  useEffect(() => {
    const write = () => {
      if (document.visibilityState === 'hidden') localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    };
    const onPageHide = () => localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    document.addEventListener('visibilitychange', write);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', write);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // ONE /api/insights fetch drives the KPI strip AND the Overview charts (no
  // duplicate fetch — the whole point of the Home/Insights merge). Activity is
  // its own endpoint (live rows + burn). Both are keyed on `days`.
  const { data: insights, stale: insightsStale } = useCachedFetch<InsightsResult>(insightsUrl(days ?? undefined));
  const { data: activity } = useCachedFetch<ActivityResult>(activityUrl(sinceRef.current, days));

  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) return <WelcomeEmpty onImport={onImport} />;

  return (
    <div className="page home-dashboard">
      <div className="dash-head">
        <h1 className="page-title">{t('Home')}</h1>
        <div className="hub-ctl">
          <div className="tabs">
            <button type="button" className={`tab ${tab === 'overview' ? 'on' : ''}`} onClick={() => selectTab('overview')}>
              {t('Overview')}
            </button>
            <button type="button" className={`tab ${tab === 'explore' ? 'on' : ''}`} onClick={() => selectTab('explore')}>
              {t('Explore')}
            </button>
            <button type="button" className={`tab ${tab === 'content' ? 'on' : ''}`} onClick={() => selectTab('content')}>
              {t('Content')}
            </button>
          </div>
          <div className="rangebar" role="tablist" aria-label={t('Time range')}>
            {WINDOWS.map((w) => (
              <button key={w.key} type="button" role="tab" aria-selected={win === w.key}
                className={win === w.key ? 'on' : ''} onClick={() => setWin(w.key)}>
                {w.key === 'today' ? t('Today') : w.key === 'all' ? t('All') : w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* `.insights-page` scope styles the charts' `.hbar` rows; the rangebar
          lives OUTSIDE it (in .dash-head) so the two `.rangebar` scopes never
          collide. No `.rangebar` is ever rendered inside this wrapper. */}
      <div className="insights-page">
        {tab === 'overview' && (
          <>
            {insights
              ? <KpiStrip result={insights} />
              : <div className="muted pad8">{t('Loading…')}</div>}

            {isToday && <ActivityBlock activity={activity} onOpenSession={onOpenSession} />}

            <BurnTile activity={activity} win={win} onOpenSession={onOpenSession} />

            {insights && (
              <div className={insightsStale ? 'range-refreshing' : undefined}>
                <InsightsCharts result={insights} days={days} />
              </div>
            )}

            <RecentLedger projects={projects} onOpenSession={onOpenSession} onRefresh={onRefresh} />
          </>
        )}
        {tab === 'explore' && <ExploreTab scope={{ type: 'all' }} days={days} />}
        {tab === 'content' && <ContentTab scope={{ type: 'all' }} days={days} />}
      </div>
    </div>
  );
}

// ---- KPI strip: headline aggregates from an InsightsResult, rendered as the
// `.kpis` tile row. The single source of the Home hub's headline numbers. ----
export function KpiStrip({ result }: { result: InsightsResult }): JSX.Element {
  const kpis = useMemo(() => {
    let cost = 0, tokens = 0, input = 0, cacheRead = 0, agentActiveMs = 0, engagedMs = 0;
    const projectsTouched = new Set<number>();
    for (const s of result.sessions) {
      cost += sessionCost(s.usage);
      tokens += sessionTokens(s.usage);
      agentActiveMs += s.agent_active_ms || 0;
      engagedMs += s.engaged_ms || 0;
      projectsTouched.add(s.project_id);
      for (const u of Object.values(parseUsage(s.usage))) {
        input += u.input || 0;
        cacheRead += u.cacheRead || 0;
      }
    }
    const toolCalls = result.toolDist.reduce((n, r) => n + r.count, 0);
    const topTool = result.toolDist[0]?.name ?? null;
    const totalHeads = result.errorsByProject.reduce((n, r) => n + r.head_count, 0);
    const errorRate = totalHeads ? (result.errors / totalHeads) * 100 : 0;
    const cachedPct = (cacheRead + input) ? (cacheRead / (cacheRead + input)) * 100 : 0;
    const leverage = engagedMs ? agentActiveMs / engagedMs : 0;
    return {
      cost, tokens, agentActiveMs, engagedMs, toolCalls, topTool, errorRate, cachedPct, leverage,
      sessionCount: result.sessions.length, projectCount: projectsTouched.size, commits: result.commits,
    };
  }, [result]);

  // Lane C proxy-lane billed spend — shown only when the LiteLLM log actually
  // has spend in range. Sub-cent values get 4 decimals so they read as non-zero.
  const laneC = result.laneC;
  const hasLaneC = laneC.requests > 0;
  const fmtLaneC = (v: number): string => {
    if (v <= 0) return fmtMoney(0, 2);
    if (v < 0.0001) return '<$0.0001';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return fmtMoney(v, 2);
  };
  const stripModel = (m: string): string => m.replace(/^openrouter\//, '');
  const laneCTip = laneC.byModel.map((m) => `${stripModel(m.model)}: ${fmtLaneC(m.spend)} · ${m.requests} ${t('req')}`).join('; ')
    + `. ${t('Billed by the LiteLLM proxy lane — authoritative $, not session-linked.')}`;
  const laneCSub = laneC.byModel.length === 1
    ? `${stripModel(laneC.byModel[0].model)} · ${laneC.requests} ${t('req')}`
    : `${laneC.byModel.length} ${t('models')} · ${laneC.requests} ${t('req')}`;

  return (
    <div className="kpis">
      <div className="kpi">
        <div className="l">{t('Spend')}</div>
        <div className="v">{fmtMoney(kpis.cost, 0)}</div>
        <div className="s">{kpis.sessionCount} {t('sessions')}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Sessions')}</div>
        <div className="v">{kpis.sessionCount}</div>
        <div className="s">{kpis.projectCount} {t('projects')}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Tokens')}</div>
        <div className="v">{fmtTok(kpis.tokens)}</div>
        <div className="s">{kpis.cachedPct.toFixed(0)}% {t('cached')}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Agent active')} <InfoTip text={t('Agent Active sums every gap between messages except gaps before a typed human prompt, each gap capped at 10 minutes; gaps ending in a tool result are never capped.')} /></div>
        <div className="v">{fmtHours(kpis.agentActiveMs)}<span className="u">h</span></div>
        <div className="s">{fmtActive(kpis.agentActiveMs)}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Your engaged')} <InfoTip text={t('Engaged sums every gap between messages, each capped at 90 minutes; unlike Agent Active, it makes no distinction between agent work and your own pauses. Leverage = agent active ÷ engaged.')} /></div>
        <div className="v">{fmtHours(kpis.engagedMs)}<span className="u">h</span></div>
        <div className="s">{t('leverage')} ×{kpis.leverage.toFixed(1)}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Tool calls')} <InfoTip text={t('Total tool invocations (Bash, Read, Edit, …) across all sessions in range. Each call and its result also carry token cost — see the Content tab.')} /></div>
        <div className="v">{fmtCount(kpis.toolCalls)}</div>
        <div className="s">{kpis.topTool ? `${kpis.topTool}-${t('heavy')}` : '—'}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Error rate')} <InfoTip text={t('Share of tool results that returned an error (heuristic match on the result text). Delta compares the prior period of the same length.')} /></div>
        <div className="v">{kpis.errorRate.toFixed(1)}<span className="u">%</span></div>
        <div className="s">{result.errors} {t('errors')}</div>
      </div>
      <div className="kpi">
        <div className="l">{t('Commits')}</div>
        <div className="v">{kpis.commits}</div>
        <div className="s">{t('linked')}</div>
      </div>
      {hasLaneC && (
        <div className="kpi">
          <div className="l">{t('Proxy lane (billed)')} <InfoTip text={laneCTip} /></div>
          <div className="v">{fmtLaneC(laneC.totalSpend)}</div>
          <div className="s">{laneCSub}</div>
        </div>
      )}
    </div>
  );
}

// ---- Activity block: live now + since-you-left. Shown only on the Today
// window (a 7d/30d "since you left" makes no sense). ----
function ActivityBlock({ activity, onOpenSession }: { activity: ActivityResult | null; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  const open = (s: ActivitySessionLite) => (onOpenSession ? onOpenSession(s.id, 0) : navigate(`/session/${encodeURIComponent(s.id)}`));
  const live = activity?.live ?? [];
  const recent = activity?.recent ?? [];

  if (!activity) return <div className="card activity-card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  if (!live.length && !recent.length) {
    return (
      <div className="card activity-card">
        <div className="muted small pad8">{t('No activity yet today — your live and recently-ended sessions will show here.')}</div>
      </div>
    );
  }

  const Row = ({ s }: { s: ActivitySessionLite }) => (
    <div className="activity-row" onClick={() => open(s)}>
      <span className={`live-dot ${s.live ? 'on' : ''}`} aria-hidden="true" />
      <span className="ar-name">{s.name}</span>
      <span className="ar-proj muted">{s.projectName}</span>
      {s.errorCount > 0 && <span className="ar-err">{pluralize(s.errorCount, t('error'), t('errors'))}</span>}
      <span className="ar-when muted">{s.live ? t('live') : formatRelativeTime(s.endedAt)}</span>
      <span className="ar-cost num-col">{fmtMoney(priceCells(s.tokensByModel), 2)}</span>
    </div>
  );

  return (
    <div className="card activity-card">
      {live.length > 0 && (
        <div className="activity-group">
          <div className="eyebrow">{t('Live now')}</div>
          {live.map((s) => <Row key={s.id} s={s} />)}
        </div>
      )}
      {recent.length > 0 && (
        <div className="activity-group">
          <div className="eyebrow">{t('Since you left')}</div>
          {recent.map((s) => <Row key={s.id} s={s} />)}
        </div>
      )}
    </div>
  );
}

// ---- Burn tile: current window spend vs a baseline (Today → 14-day daily
// median; Nd → prior-Nd; All → NO baseline, since none honestly exists over an
// unbounded window). Warn tint (--warn) when spend runs >2× the baseline. ----
function BurnTile({ activity, win, onOpenSession }: { activity: ActivityResult | null; win: WindowKey; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  if (!activity) return <div className="card burn-card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  const burn = activity.burn;
  const current = priceCells(burn.windowSpendTokensByModel);
  const baseline = priceCells(burn.baselineTokensByModel);
  const hasBaseline = baseline > 0;
  const ratio = hasBaseline ? current / baseline : null;
  const hot = ratio != null && ratio > 2;
  const baselineLabel = win === 'today' ? t('typical day (14-day median)')
    : win === '7d' ? t('prior 7 days')
    : win === '30d' ? t('prior 30 days')
    : win === '90d' ? t('prior 90 days')
    : '';
  // Comparison bar: baseline is the 100% reference; current fills relative to it
  // (capped at 100% width). Only meaningful when a baseline exists.
  const fillPct = hasBaseline ? Math.min((current / baseline) * 100, 100) : 0;

  const topCost = priceCells(burn.topSessionTokensByModel);
  const openTop = () => {
    if (!burn.topSessionId) return;
    if (onOpenSession) onOpenSession(burn.topSessionId, 0);
    else navigate(`/session/${encodeURIComponent(burn.topSessionId)}`);
  };

  return (
    <div className={`card burn-card ${hot ? 'warn' : ''}`}>
      <div className="burn-head">
        <span className="eyebrow">{t('Burn rate')}</span>
        <InfoTip text={t('Your spend in this window versus a baseline (Today uses the median of the last 14 complete days; longer windows use the prior period). Over 2× the baseline is flagged.')} />
      </div>
      <div className="burn-row">
        <div className="burn-now">
          <div className="v">{fmtMoney(current, current < 1 ? 2 : 0)}</div>
          {hasBaseline
            ? <div className="s muted">{t('vs')} {fmtMoney(baseline, baseline < 1 ? 2 : 0)} · {baselineLabel}</div>
            : <div className="s muted">{t('all time · no baseline')}</div>}
        </div>
        {ratio != null && (
          <div className={`burn-ratio ${hot ? 'hot' : ''}`}>
            ×{ratio.toFixed(1)}{hot && <span className="burn-flag"> {t('high')}</span>}
          </div>
        )}
      </div>
      {hasBaseline && (
        <div className="burn-bar" aria-hidden="true">
          <div className="burn-baseline" />
          <div className={`burn-fill ${hot ? 'hot' : ''}`} style={{ width: `${fillPct}%` }} />
        </div>
      )}
      {burn.topSessionId && (
        <div className="burn-top" onClick={openTop} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') openTop(); }}>
          <span className="eyebrow">{t('Top session')}</span>
          <span className="bt-name">{burn.topSessionName}</span>
          <span className="bt-cost num-col">{fmtMoney(topCost, 2)}</span>
        </div>
      )}
    </div>
  );
}

// ---- Insights Overview charts (everything the old InsightsPage Overview showed
// AFTER the KPI strip): spend-over-time stacked chart, spend-by-model/sources,
// Working Rhythm, tool mix / error rate, token-by-model table, top sessions.
// The KPI strip is rendered by the hub above this, so it is NOT repeated here. ----
function InsightsCharts({ result, days }: { result: InsightsResult; days: number | null }): JSX.Element {
  const [, navigate] = useLocation();
  const rangeLabel = days ? `${Math.round(days)}d` : t('All');

  const projectById = useMemo(() => new Map(result.projects.map((p) => [p.id, p.name])), [result]);
  const projectColors = useMemo(() => projectColorMap(result.projects.map((p) => p.id)), [result]);

  // ---- Spend over time · stacked by project (top 5 by spend in range + Other) ----
  const projectSpend = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of result.sessions) {
      const cost = sessionCost(s.usage);
      if (!cost) continue;
      m.set(s.project_id, (m.get(s.project_id) ?? 0) + cost);
    }
    return m;
  }, [result]);
  const projectsBySpend = useMemo(
    () => [...result.projects].sort((a, b) => (projectSpend.get(b.id) ?? 0) - (projectSpend.get(a.id) ?? 0)),
    [result, projectSpend],
  );
  const topProjects = useMemo(() => projectsBySpend.slice(0, 5), [projectsBySpend]);
  const otherProjectIds = useMemo(() => new Set(projectsBySpend.slice(5).map((p) => p.id)), [projectsBySpend]);
  const spendChartData = useMemo(() => {
    const byDay = new Map<string, Record<string, number>>();
    for (const s of result.sessions) {
      if (!s.started_at) continue;
      const cost = sessionCost(s.usage);
      if (!cost) continue;
      const day = s.started_at.slice(0, 10);
      const key = otherProjectIds.has(s.project_id) ? 'other' : String(s.project_id);
      const row = byDay.get(day) ?? {};
      row[key] = (row[key] ?? 0) + cost;
      byDay.set(day, row);
    }
    return [...byDay.keys()].sort().map((day) => ({ day: fmtDayLabel(day), ...byDay.get(day) }));
  }, [result, otherProjectIds]);
  const hasOther = otherProjectIds.size > 0;

  // ---- Spend by model (hbar) ----
  const spendByModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of result.sessions) {
      for (const [model, u] of Object.entries(parseUsage(s.usage))) {
        m.set(model, (m.get(model) ?? 0) + (costOf(model, u) ?? 0));
      }
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [result]);

  // ---- Sources (hbar) ----
  const bySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of result.sessions) m.set(s.source, (m.get(s.source) ?? 0) + 1);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [result]);

  // ---- Global tool mix (top 5 + Other) ----
  const toolMix = useMemo(() => {
    const top = result.toolDist.slice(0, 5).map((r) => ({ name: r.name, value: r.count }));
    const rest = result.toolDist.slice(5).reduce((n, r) => n + r.count, 0);
    return rest ? [...top, { name: t('Other'), value: rest }] : top;
  }, [result]);

  // ---- Error rate by project (top 6) ----
  const errorRateByProject = useMemo(() => {
    return result.errorsByProject
      .filter((r) => r.head_count > 0)
      .map((r) => ({ name: projectById.get(r.project_id) ?? `#${r.project_id}`, value: (r.error_count / r.head_count) * 100 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [result, projectById]);

  // ---- Token usage by model table ----
  const tokenTable = useMemo(() => {
    const agg = new Map<string, { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; cost: number }>();
    for (const s of result.sessions) {
      for (const [model, u] of Object.entries(parseUsage(s.usage))) {
        const cur = agg.get(model) ?? { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, cost: 0 };
        cur.input += u.input || 0;
        cur.output += u.output || 0;
        cur.cacheRead += u.cacheRead || 0;
        cur.cw5m += u.cacheWrite5m ?? u.cacheWrite ?? 0;
        cur.cw1h += u.cacheWrite1h || 0;
        cur.cost += costOf(model, u) ?? 0;
        agg.set(model, cur);
      }
    }
    const msgsByModel = new Map(result.modelDist.map((r) => [r.model, r.count]));
    return [...agg.entries()].map(([model, v]) => ({
      model, ...v,
      hitRate: (v.cacheRead + v.input) ? (v.cacheRead / (v.cacheRead + v.input)) * 100 : 0,
      msgs: msgsByModel.get(model) ?? 0,
    })).sort((a, b) => b.cost - a.cost);
  }, [result]);
  const tokenTotals = useMemo(() => tokenTable.reduce((acc, r) => ({
    input: acc.input + r.input, output: acc.output + r.output, cacheRead: acc.cacheRead + r.cacheRead,
    cw5m: acc.cw5m + r.cw5m, cw1h: acc.cw1h + r.cw1h, cost: acc.cost + r.cost, msgs: acc.msgs + r.msgs,
  }), { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, cost: 0, msgs: 0 }), [tokenTable]);
  const tokenTotalsHitRate = (tokenTotals.cacheRead + tokenTotals.input)
    ? (tokenTotals.cacheRead / (tokenTotals.cacheRead + tokenTotals.input)) * 100 : 0;

  // ---- Top sessions by cost ----
  const topSessions = useMemo(() => {
    return result.sessions
      .map((s) => ({ session: s, cost: sessionCost(s.usage), tokens: sessionTokens(s.usage) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 15);
  }, [result]);

  return (
    <>
      <div className="grid2">
        <div className="card">
          <h3>{t('Spend over time · stacked by project')}</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendChartData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="day" {...AXIS_PROPS} />
              <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => fmtMoney(v, 0)} />
              <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} formatValue={(v) => fmtMoney(Number(v), 2)} />} />
              {topProjects.map((p, i) => (
                <Bar key={p.id} dataKey={String(p.id)} stackId="a" name={p.name} fill={projectColors.get(p.id) ?? CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]} />
              ))}
              {hasOther && <Bar dataKey="other" stackId="a" name={t('Other')} fill="var(--ink-3)" />}
            </BarChart>
          </ResponsiveContainer>
          <div className="legend">
            {topProjects.map((p) => (
              <span key={p.id}><span className="dot" style={{ background: projectColors.get(p.id) ?? 'var(--ink-3)' }} />{p.name}</span>
            ))}
            {hasOther && <span style={{ color: 'var(--ink-3)' }}>+ {otherProjectIds.size} {t('in Other')}</span>}
          </div>
        </div>
        <div className="card">
          <h3>{t('Spend by model')} · {rangeLabel}</h3>
          {spendByModel.map((r, i) => {
            const max = spendByModel[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n">{r.name}</span>
                <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{fmtMoney(r.value, 0)}</span>
              </div>
            );
          })}
          <h3 style={{ marginTop: 14 }}>{t('Sources')}</h3>
          {bySource.map((r, i) => {
            const max = bySource[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n">{r.name}</span>
                <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{r.value}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid2b">
        <WorkingRhythm result={result} />
        <div className="card">
          <h3>{t('Global tool mix')}</h3>
          {toolMix.map((r, i) => {
            const max = toolMix[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n">{r.name}</span>
                <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{fmtInt(r.value)}</span>
              </div>
            );
          })}
          <h3 style={{ marginTop: 14 }}>{t('Error rate by project')}</h3>
          {errorRateByProject.map((r, i) => {
            const max = errorRateByProject[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n">{r.name}</span>
                <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{r.value.toFixed(1)}%</span>
              </div>
            );
          })}
          {!errorRateByProject.length && <div className="muted small">{t('No errors in range.')}</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>{t('Token usage by model')} · {rangeLabel}</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('Model')}</th>
              <th>{t('Input')}</th>
              <th>{t('Output')}</th>
              <th>{t('Cache Read')}</th>
              <th>{t('Cache Write')} <span className="ttl-tag">5m</span></th>
              <th>{t('Cache Write')} <span className="ttl-tag">1h</span></th>
              <th>{t('Hit rate')} <InfoTip text={t('Cache read ÷ (cache read + input): the share of prompt-side tokens served from cache instead of re-sent at full input price. Higher = cheaper turns.')} /></th>
              <th>{t('Msgs')}</th>
              <th>{t('Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {tokenTable.map((r, i) => (
              <tr key={r.model}>
                <td><span className="dot" style={{ background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} />{r.model}</td>
                <td>{fmtTok(r.input)}</td>
                <td>{fmtTok(r.output)}</td>
                <td>{fmtTok(r.cacheRead)}</td>
                <td>{r.cw5m ? fmtTok(r.cw5m) : '—'}</td>
                <td>{r.cw1h ? fmtTok(r.cw1h) : '—'}</td>
                <td>{r.hitRate.toFixed(0)}%</td>
                <td>{fmtInt(r.msgs)}</td>
                <td className="cost">{fmtMoney(r.cost, 2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{t('All models')}</td>
              <td>{fmtTok(tokenTotals.input)}</td>
              <td>{fmtTok(tokenTotals.output)}</td>
              <td>{fmtTok(tokenTotals.cacheRead)}</td>
              <td>{tokenTotals.cw5m ? fmtTok(tokenTotals.cw5m) : '—'}</td>
              <td>{tokenTotals.cw1h ? fmtTok(tokenTotals.cw1h) : '—'}</td>
              <td>{tokenTotalsHitRate.toFixed(0)}%</td>
              <td>{fmtInt(tokenTotals.msgs)}</td>
              <td className="cost">{fmtMoney(tokenTotals.cost, 2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>{t('Top sessions by cost')} · {rangeLabel}</h3>
        {/* `.pane` (min-width:0 + overflow:auto) so a long session title scrolls
            this table internally instead of widening the whole page. */}
        <div className="pane">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{t('Session')}</th>
                <th style={{ textAlign: 'left' }}>{t('Project')}</th>
                <th>{t('Cost')}</th>
                <th>{t('Tokens')}</th>
                <th>{t('Active')}</th>
                <th>{t('When')}</th>
              </tr>
            </thead>
            <tbody>
              {topSessions.map(({ session, cost, tokens }) => (
                <tr key={session.id} className="rowlink" onClick={() => navigate(`/session/${encodeURIComponent(session.id)}`)}>
                  <td>{sessionDisplayName(session)}</td>
                  <td style={{ textAlign: 'left', color: projectColors.get(session.project_id) ?? 'var(--brass-text)' }}>{session.project_name}</td>
                  <td className="cost">{fmtMoney(cost, 2)}</td>
                  <td>{fmtTok(tokens)}</td>
                  <td>{fmtActive(session.agent_active_ms || 0)}</td>
                  <td>{session.started_at ? fmtDayLabel(session.started_at.slice(0, 10)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!topSessions.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
      </div>
    </>
  );
}
