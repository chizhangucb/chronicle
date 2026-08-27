import React, { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  insightsUrl, activityUrl,
  type InsightsResult, type ActivityResult, type ActivityTokensByModel, type ActivitySessionLite,
} from './api.js';
import { sessionDisplayName } from './ProjectDetail.jsx';
import { WelcomeEmpty } from './ProjectsPage.js';
import type { ProjectSummary } from './ProjectsPage.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { costOf, type CostMode } from './models.js';
import { fmtInt, fmtMoney, pluralize } from './format.js';
import { formatRelativeTime } from './relativeTime.js';
import { t, lang } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import WorkingRhythm from './insights/WorkingRhythm.tsx';
import SpendOverTime from './insights/SpendOverTime.tsx';
import SpendTab from './SpendTab.tsx';
import SessionsHubTab from './SessionsHubTab.tsx';
import SortCaret from './SortCaret.tsx';
import { CATEGORICAL_COLORS, projectColorMap } from './colors.ts';
import { fmtDayLabel } from './charts/timeBuckets.ts';
import { sumByModel, groupByKey, costOfBucketedCells, tokensOfCells, sumFields, splitAutomation } from './windowedUsage.ts';
import { useCostMode } from './costMode.tsx';
import ExploreTab from './ExploreTab.tsx';
import ContentTab from './ContentTab.tsx';
import RangeBar, { rangeDays, type RangeKey } from './RangeBar.tsx';
import { MOVER_GLYPH, windowAnomaly } from './insights/anomalyMath.ts';

// The ONE Insights hub at `/` (product-IA fix, 2026-08-13; renamed sidebar
// item + page title Home → Insights, Task 9). Home and the old `/insights`
// page are merged into a single tabbed surface — Overview / Explore / Content
// — so there is exactly one KPI strip and one `/api/insights` fetch, never two
// pages showing the same aggregates. Overview reading order, top→bottom: KPI
// strip (with the window toggle) → Activity block (live + since-you-left,
// Today only) → Burn tile → the Insights Overview charts. The recent-sessions
// ledger no longer mounts here — it moved to `/projects` as the main column
// next to the projects rail (D1: the moving list is what people want to see
// live; see RecentLedger.tsx and ProjectsPage.tsx). Explore/Content reuse the
// existing tab components at scope=all.

type Tab = 'overview' | 'explore' | 'content' | 'spend' | 'sessions';

// Window toggle: all five options live on this ONE surface (spec §2.2a). Today =
// fractional-days-since-local-midnight; All = no cutoff (days omitted). The
// option set + labels + `days` resolution are shared with ProjectDetail via
// RangeBar.tsx (D10, Task 17) so the two vocabularies cannot drift again.
type WindowKey = RangeKey;
const windowDays = rangeDays;

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
// Price a bag of per-model token cells client-side (the price table lives ONLY
// in src/models.ts — hard constraint; the server returns tokens, never $).
// `mode` (CHI-233 Part C) defaults to theoretical/list price.
function priceCells(byModel: ActivityTokensByModel, mode: CostMode = 'theoretical'): number {
  let total = 0;
  for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell, undefined, mode) ?? 0;
  return total;
}
// Same as priceCells, but prices EACH day's cells at that day's own rate
// before summing (CHI-228) — for burn.windowSpendTokensByModelByDay, the
// figure that overstates Sonnet-5-heavy spend under a single flat rate.
function priceCellsByDay(byDayModel: Record<string, ActivityTokensByModel>, mode: CostMode = 'theoretical'): number {
  let total = 0;
  for (const [day, byModel] of Object.entries(byDayModel)) {
    for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell, day, mode) ?? 0;
  }
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
  const tab: Tab =
    tabParam === 'explore' ? 'explore'
    : tabParam === 'content' ? 'content'
    : tabParam === 'spend' ? 'spend'
    : tabParam === 'sessions' ? 'sessions'
    : 'overview';
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
        <h1 className="page-title">{t('Insights')}</h1>
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
            <button type="button" className={`tab ${tab === 'spend' ? 'on' : ''}`} onClick={() => selectTab('spend')}>
              {t('Spend')}
            </button>
            <button type="button" className={`tab ${tab === 'sessions' ? 'on' : ''}`} onClick={() => selectTab('sessions')}>
              {t('Sessions')}
            </button>
          </div>
          <RangeBar value={win} onChange={setWin} />
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

            <AnomalyTile activity={activity} insights={insights} win={win} days={days} onOpenSession={onOpenSession} />

            {insights && (
              <div className={insightsStale ? 'range-refreshing' : undefined}>
                <InsightsCharts result={insights} days={days} />
              </div>
            )}
          </>
        )}
        {tab === 'explore' && <ExploreTab scope={{ type: 'all' }} days={days} />}
        {tab === 'content' && <ContentTab scope={{ type: 'all' }} days={days} />}
        {tab === 'spend' && <SpendTab insights={insights} activity={activity} win={win} days={days} />}
        {tab === 'sessions' && <SessionsHubTab insights={insights} />}
      </div>
    </div>
  );
}

// ---- KPI strip: headline aggregates from an InsightsResult, rendered as the
// `.kpis` tile row. The single source of the Home hub's headline numbers. ----
export function KpiStrip({ result }: { result: InsightsResult }): JSX.Element {
  const { mode } = useCostMode();
  const kpis = useMemo(() => {
    let agentActiveMs = 0, engagedMs = 0;
    const projectsTouched = new Set<number>();
    for (const s of result.sessions) {
      agentActiveMs += s.agent_active_ms || 0;
      engagedMs += s.engaged_ms || 0;
      projectsTouched.add(s.project_id);
    }
    // Windowed cells (Task 2/3): a session that started before the window but
    // ran INTO it contributes only its in-window share here, instead of
    // vanishing (old gate) or counting its full historical usage.
    const byModel = sumByModel(result.windowedTokensByModel);
    const tokens = tokensOfCells(byModel);
    const { input, cacheRead } = sumFields(byModel);
    // Automation split (CHI-233 Part C): manifest session_ids are excluded from
    // the headline INTERACTIVE count and bucketed by job. `interactiveCells` is
    // the windowed cells for NON-manifest sessions; automation.automationCost
    // is present-transcript + absent-transcript automation spend. Total spend =
    // interactive + automation (broken out, never hidden). Day-bucketed pricing
    // (CHI-228) throughout so a rate-change straddle prices per day.
    const manifestIds = new Set(result.machineSessions.ids);
    const interactiveCells = result.windowedTokensByModel.filter((c) => !manifestIds.has(c.sessionId));
    const interactiveSpend = costOfBucketedCells(interactiveCells, mode);
    const automation = splitAutomation(result.sessions, result.windowedTokensByModel, result.machineSessions, mode);
    const cost = interactiveSpend + automation.automationCost;
    const toolCalls = result.toolDist.reduce((n, r) => n + r.count, 0);
    const topTool = result.toolDist[0]?.name ?? null;
    const totalHeads = result.errorsByProject.reduce((n, r) => n + r.head_count, 0);
    const errorRate = totalHeads ? (result.errors / totalHeads) * 100 : 0;
    const cachedPct = (cacheRead + input) ? (cacheRead / (cacheRead + input)) * 100 : 0;
    const leverage = engagedMs ? agentActiveMs / engagedMs : 0;
    return {
      cost, interactiveSpend, automation, tokens, agentActiveMs, engagedMs, toolCalls, topTool, errorRate, cachedPct, leverage,
      sessionCount: automation.interactiveSessionCount, projectCount: projectsTouched.size, commits: result.commits,
    };
  }, [result, mode]);
  // Automation transparency (CHI-233 Part C, hard requirement): the interactive
  // count carries a visible "N automation excluded" sub-label + a by-job
  // tooltip; the Spend tile breaks out the automation portion.
  const auto = kpis.automation;
  const modeLabel = mode === 'real' ? t('billed ~$0 under subscription') : t('list price');
  const autoByJobText = auto.byJob.length
    ? auto.byJob.map((b) => `${b.job}: ${fmtMoney(b.cost, 2)} · ${b.sessions}`).join('; ')
    : t('none in range');

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
        <div className="l">{t('Spend')} <span className="lbl" title={modeLabel}>· {modeLabel}</span> <InfoTip text={t('Priced locally from billed token counts, never billed data; sessions that started before the window but ran into it are pro-rated by their in-window token share. Total includes automation spend, broken out below. Toggle List price vs Billed in the topbar.')} /></div>
        <div className="v">{fmtMoney(kpis.cost, 0)}</div>
        <div className="s" title={`${t('interactive')} ${fmtMoney(kpis.interactiveSpend, 2)} · ${t('automation')} ${fmtMoney(auto.automationCost, 2)} (${autoByJobText})`}>
          {t('incl.')} {fmtMoney(auto.automationCost, auto.automationCost < 1 ? 2 : 0)} {t('automation')}
        </div>
      </div>
      <div className="kpi">
        <div className="l">{t('Sessions')} <InfoTip text={t('Interactive sessions only. Headless automation runs (weekly/nightly/session-close/spend-advice) are counted separately as automation, not here. A manifest session whose transcript is also imported is counted once, as automation.')} /></div>
        <div className="v">{kpis.sessionCount}</div>
        <div className="s" title={`${t('automation by job')}: ${autoByJobText}`}>
          {kpis.projectCount} {t('projects')} · {auto.automationSessionCount} {t('automation excluded')}
        </div>
      </div>
      <div className="kpi">
        <div className="l">{t('Tokens')} <InfoTip text={t('Input + output tokens billed across sessions in range; cache reads/writes are excluded from this count. % cached = cache reads ÷ (cache reads + fresh input).')} /></div>
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
        <div className="l">{t('Commits')} <InfoTip text={t('Git commits within this window (a raw git log count) — not filtered to only commits a tracked session caused.')} /></div>
        <div className="v">{kpis.commits}</div>
        <div className="s">{t('linked')}</div>
      </div>
      {hasLaneC && (
        <div className="kpi">
          <div className="l"><span className="lbl" title={t('Proxy lane (billed)')}>{t('Proxy lane (billed)')}</span> <InfoTip text={laneCTip} /></div>
          <div className="v">{fmtLaneC(laneC.totalSpend)}</div>
          <div className="s" title={laneCSub}>{laneCSub}</div>
        </div>
      )}
    </div>
  );
}

// ---- Activity block: live now + since-you-left. Shown only on the Today
// window (a 7d/30d "since you left" makes no sense). ----
function ActivityBlock({ activity, onOpenSession }: { activity: ActivityResult | null; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  const { mode } = useCostMode();
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
      <span className="ar-name" title={s.name}>{s.name}</span>
      <span className="ar-proj muted" title={s.projectName}>{s.projectName}</span>
      {s.errorCount > 0 && <span className="ar-err">{pluralize(s.errorCount, t('error'), t('errors'))}</span>}
      <span className="ar-when muted">{s.live ? t('live') : formatRelativeTime(s.endedAt)}</span>
      <span className="ar-cost num-col">{fmtMoney(priceCells(s.tokensByModel, mode), 2)}</span>
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
function AnomalyTile({ activity, insights, win, days, onOpenSession }: { activity: ActivityResult | null; insights: InsightsResult | null; win: WindowKey; days: number | null; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  const { mode } = useCostMode();
  // Hooks run unconditionally (rules-of-hooks) — the null-activity guard reads
  // the memoized value but never skips the hook.
  const burn = activity?.burn ?? null;
  // ONE shared window-scoped anomaly view (identical to the Spend-tab card).
  const anom = useMemo(() => (burn ? windowAnomaly(burn, mode, days) : null), [burn, mode, days]);
  // Top session ranked by COST in this window (CHI-324 review — the old server
  // pick ranked by TOKENS but showed cost, so a wider window's top could show a
  // SMALLER figure than a narrower one). The insights windowed cells give the
  // in-window per-session share, so the max-cost pick is monotonic across widening
  // windows and respects the List/Billed toggle. Same math the retired
  // Top-sessions-by-cost table used.
  const topSession = useMemo(() => {
    if (!insights) return null;
    const bySession = groupByKey(insights.windowedTokensByModel, (c) => c.sessionId);
    let best: { row: InsightsResult['sessions'][number]; cost: number } | null = null;
    for (const s of insights.sessions) {
      const cost = costOfBucketedCells(bySession.get(s.id) ?? [], mode);
      if (cost > 0 && (!best || cost > best.cost)) best = { row: s, cost };
    }
    return best;
  }, [insights, mode]);

  if (!activity || !burn || !anom) return <div className="card burn-card"><div className="muted small pad8">{t('Loading…')}</div></div>;

  const { current, baseline, hasBaseline, ratio, hot, topProject, topModel, flaggedDays, laneCToday } = anom;
  const baselineLabel = win === 'today' ? t('typical day (14-day median)')
    : win === '7d' ? t('prior 7 days')
    : win === '30d' ? t('prior 30 days')
    : win === '90d' ? t('prior 90 days')
    : '';
  // Window span for the no-baseline support line, so a bounded window that just
  // lacks a full PRIOR period (not enough history yet) never mislabels as "all
  // time" (CHI-324 review — 90d had no prior-90d in range).
  const winSpanLabel = win === '7d' ? t('last 7 days')
    : win === '30d' ? t('last 30 days')
    : win === '90d' ? t('last 90 days')
    : win === 'today' ? t('today')
    : t('all time');
  const fillPct = hasBaseline ? Math.min((current / baseline) * 100, 100) : 0;

  const openTop = () => {
    if (!topSession) return;
    if (onOpenSession) onOpenSession(topSession.row.id, topSession.row.project_id);
    else navigate(`/session/${encodeURIComponent(topSession.row.id)}`);
  };

  // Multi-day windows carry the flagged-days line (single-day Today has none).
  const showFlaggedDays = win !== 'today' && flaggedDays.length > 0;

  return (
    <div className={`card burn-card ${hot ? 'warn' : ''}`}>
      <div className="burn-head">
        <span className="eyebrow">{t('Spend anomaly')}</span>
        <InfoTip text={t('Your spend in this window versus a baseline (Today uses the median of the last 14 complete days; longer windows use the prior period of equal length). Over 2× the baseline is flagged. The movers are the top project and model by spend in this window.')} />
      </div>
      <div className="burn-row">
        <div className="burn-now">
          {ratio != null
            ? <div className="v">×{ratio.toFixed(1)}{hot && <span className="burn-flag"> {t('high')}</span>}</div>
            : <div className="v">{fmtMoney(current, current < 1 ? 2 : 0)}</div>}
          {hasBaseline
            ? <div className="s muted">{fmtMoney(current, current < 1 ? 2 : 0)} {t('vs')} {fmtMoney(baseline, baseline < 1 ? 2 : 0)} · {baselineLabel}</div>
            : <div className="s muted">{win === 'all' ? t('all time · no baseline') : `${winSpanLabel} · ${t('no prior period to compare yet')}`}</div>}
        </div>
      </div>
      {hasBaseline && (
        <div className="burn-bar" aria-hidden="true">
          <div className="burn-baseline" />
          <div className={`burn-fill ${hot ? 'hot' : ''}`} style={{ width: `${fillPct}%` }} />
        </div>
      )}

      {/* Movers: top project + top model by spend in this window (moves with the
          window). Each lens is one glyph + label + name + window spend. */}
      {(topProject || topModel) && (
        <div className="anom-mover">
          {topProject && (
            <span>
              <span className="anom-glyph">{MOVER_GLYPH.project}</span>{' '}
              <span className="muted">{t('top project')} </span>
              <b>{topProject.value}</b> {fmtMoney(topProject.cost, topProject.cost < 1 ? 2 : 0)}
            </span>
          )}
          {topProject && topModel && <span className="anom-sep"> · </span>}
          {topModel && (
            <span>
              <span className="anom-glyph">{MOVER_GLYPH.model}</span>{' '}
              <span className="muted">{t('top model')} </span>
              <b>{topModel.value}</b> {fmtMoney(topModel.cost, topModel.cost < 1 ? 2 : 0)}
            </span>
          )}
        </div>
      )}
      {/* Lane C honesty note — the total can move on unattributable proxy spend. */}
      {laneCToday > 0 && (
        <div className="anom-lanec" title={t(LANE_C_NOTE_TIP)}>
          {t('incl.')} {fmtMoney(laneCToday, 2)} {t('proxy lane, not attributable to a mover')}
        </div>
      )}
      {/* Flagged-days line (multi-day windows) → deep-links to the Spend tab. The
          date shows only for a lone flag; a longer window only adds OLDER flags,
          so a single latest date would look "stuck" as the count grows. */}
      {showFlaggedDays && (
        <div className="anom-flagged" onClick={() => navigate('/?tab=spend')} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate('/?tab=spend'); }}>
          {pluralize(flaggedDays.length, t('flagged day'), t('flagged days'))}
          {flaggedDays.length === 1 && <>{' · '}{fmtDayLabel(flaggedDays[0].day, localeOf())}</>}
          {' '}<span className="anom-arrow">→</span>
        </div>
      )}

      {topSession && (
        <div className="burn-top" onClick={openTop} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') openTop(); }}>
          <span className="eyebrow">{t('Top session')}</span>
          <span className="bt-name" title={sessionDisplayName(topSession.row)}>{sessionDisplayName(topSession.row)}</span>
          <span className="bt-cost num-col">{fmtMoney(topSession.cost, 2)}</span>
        </div>
      )}
    </div>
  );
}

// The Lane C caveat tooltip (mirrors LANE_C_UNATTRIBUTED_DEFINITION intent;
// kept local so the tile has no server import beyond the shared math).
const LANE_C_NOTE_TIP =
  'Proxy-lane (LiteLLM/OpenRouter) spend is billed on its own log with no session, project, or model attribution, so it is added to the total but never shown as a per-dimension driver.';


// ---- Insights Overview charts (everything the old InsightsPage Overview showed
// AFTER the KPI strip): spend-over-time stacked chart, spend-by-model/sources,
// Working Rhythm, tool mix / error rate, token-by-model table, top sessions.
// The KPI strip is rendered by the hub above this, so it is NOT repeated here. ----
function InsightsCharts({ result, days }: { result: InsightsResult; days: number | null }): JSX.Element {
  const [, navigate] = useLocation();
  const { mode } = useCostMode();
  // Same fix as ExploreTab.tsx's rangeLabel: days<1 (fractional
  // days-since-local-midnight, the Today window) reads "Today", not "0d" —
  // Math.round alone would silently round Today down to zero days.
  const rangeLabel = days == null ? t('All') : days < 1 ? t('Today') : `${Math.round(days)}d`;

  const projectById = useMemo(() => new Map(result.projects.map((p) => [p.id, p.name])), [result]);
  const projectColors = useMemo(() => projectColorMap(result.projects.map((p) => p.id)), [result]);

  // Spend by model retired from Overview (CHI-324 review #4) — see the render.

  // Sources moved to the Spend tab (CHI-324 review) — paired with Spend by model.

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
    const byModel = sumByModel(result.windowedTokensByModel);
    // Day-bucketed pricing (CHI-228) for the $ column, same reasoning as
    // spendByModel above.
    const byModelCells = groupByKey(result.windowedTokensByModel, (c) => c.model);
    const msgsByModel = new Map(result.modelDist.map((r) => [r.model, r.count]));
    return [...byModel.entries()].map(([model, cell]) => ({
      model,
      input: cell.input, output: cell.output, cacheRead: cell.cacheRead,
      cw5m: cell.cacheWrite5m, cw1h: cell.cacheWrite1h,
      cost: costOfBucketedCells(byModelCells.get(model) ?? [], mode),
      hitRate: (cell.cacheRead + cell.input) ? (cell.cacheRead / (cell.cacheRead + cell.input)) * 100 : 0,
      msgs: msgsByModel.get(model) ?? 0,
    })).sort((a, b) => b.cost - a.cost);
  }, [result, mode]);
  const tokenTotals = useMemo(() => tokenTable.reduce((acc, r) => ({
    input: acc.input + r.input, output: acc.output + r.output, cacheRead: acc.cacheRead + r.cacheRead,
    cw5m: acc.cw5m + r.cw5m, cw1h: acc.cw1h + r.cw1h, cost: acc.cost + r.cost, msgs: acc.msgs + r.msgs,
  }), { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, cost: 0, msgs: 0 }), [tokenTable]);
  const tokenTotalsHitRate = (tokenTotals.cacheRead + tokenTotals.input)
    ? (tokenTotals.cacheRead / (tokenTotals.cacheRead + tokenTotals.input)) * 100 : 0;

  // Top sessions by cost is RETIRED from Overview (CHI-324) — absorbed by the
  // Sessions tab's cost sort. The product ends with exactly two session lists:
  // the /projects ledger and the Sessions tab.

  return (
    <>
      {/* Spend-over-time is FULL-WIDTH on Overview (CHI-324 review): it's the
          headline chart, and Spend by model + Sources both moved to the Spend
          tab (de-duped, and pairing the tall chart with a 2-row Sources card
          left an ugly empty half). */}
      <SpendOverTime result={result} />

      <div className="grid2b">
        <WorkingRhythm result={result} />
        <div className="card">
          <h3>{t('Global tool mix')}</h3>
          {toolMix.map((r, i) => {
            const max = toolMix[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n" title={r.name ?? undefined}>{r.name}</span>
                <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v num">{fmtInt(r.value)}</span>
              </div>
            );
          })}
          <h3>{t('Error rate by project')}</h3>
          {errorRateByProject.map((r, i) => {
            const max = errorRateByProject[0]?.value || 1;
            return (
              <div className="hbar" key={r.name}>
                <span className="n" title={r.name}>{r.name}</span>
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
              <th>{t('Msgs')} <InfoTip text={t('Every normalized event row — user, assistant, thinking, tool call, and tool result — not just human/assistant chat turns.')} /></th>
              <th className="sort-on">{t('Cost')}<SortCaret on /></th>
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

    </>
  );
}
