import React, { useMemo, useState, type JSX } from 'react';
import type { InsightsResult, ActivityResult } from './api.js';
import { insightsUrl } from './api.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { useCostMode } from './costMode.tsx';
import { costOf } from './models.js';
import { costOfBucketedCells, groupByBucket, groupByKey, type BucketedCell } from './windowedUsage.ts';
import { fmtMoney } from './format.js';
import { t } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import type { RangeKey } from './RangeBar.tsx';
import SpendOverTime from './insights/SpendOverTime.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import { computeFlaggedDays, type CostedDay } from '../shared/spend/anomaly.ts';
import { computeBudgetPosture } from '../shared/spend/budget.ts';
import { DEFAULT_SPEND_THRESHOLDS, LANE_C_UNATTRIBUTED_DEFINITION } from '../shared/spend/thresholds.ts';
import { MOVER_GLYPH, buildCostedDays, windowStartDay, topDimInWindow } from './insights/anomalyMath.ts';

// The Spend tab (CHI-324 2b/2d/2e/2f) — the deep spend view. Reading order:
// posture row (Budget + Anomaly) → chart row (spend-over-time + spend-by-model)
// → plan windows → efficiency → skills/MCP → proxy lane. This increment ships
// the posture row, chart row, and proxy lane; the three server-backed sections
// (plan windows = quota reads, efficiency = detectors/roster, skills/MCP =
// explore spend) land next. Chronicle's grammar; Varde content only.

const WIN_LABEL: Record<RangeKey, string> = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', all: 'All' };
const BUDGET_KEY = 'chronicle.monthlyBudget';

function readBudget(): number | null {
  try { const v = localStorage.getItem(BUDGET_KEY); const n = v ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; }
  catch { return null; }
}

export default function SpendTab({ insights, activity, win, days }: {
  insights: InsightsResult | null; activity: ActivityResult | null; win: RangeKey; days: number | null;
}): JSX.Element {
  const { mode } = useCostMode();
  const today = activity?.burn.today ?? null;

  // Budget is MONTH-scoped, independent of the rangebar: fetch a month-to-date
  // insights (days = day-of-month) so the meter is right on any window.
  const dayOfMonth = today ? Number(today.slice(8, 10)) : null;
  const { data: monthInsights } = useCachedFetch<InsightsResult>(insightsUrl(dayOfMonth ?? undefined));

  return (
    <div className="spend-tab">
      <PostureRow insights={insights} activity={activity} monthInsights={monthInsights} win={win} days={days} />
      <div className="grid2">
        {insights ? <SpendOverTime result={insights} /> : <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>}
        <SpendByModelCard insights={insights} win={win} />
      </div>
      <PlaceholderCard title={t('Plan windows')} sub={t('per account')} note={t('Building next — one card per account (Claude 5h / 7d / top-tier · Codex 7d), quota-read, Settings opt-out.')} />
      <PlaceholderCard title={t('Efficiency')} note={t('Building next — detectors (cache hit · jumbo · long context · error rows), waste signals, and routing compliance.')} />
      <PlaceholderCard title={t('Priced skills & MCP spend')} note={t('Building next — skill and per-server spend from the Explore engine.')} />
      <ProxyLaneRow insights={insights} />
    </div>
  );
}

// ---- Posture row: Budget (1fr) + Anomaly (1.4fr) ----
function PostureRow({ insights, activity, monthInsights, win, days }: {
  insights: InsightsResult | null; activity: ActivityResult | null; monthInsights: InsightsResult | null; win: RangeKey; days: number | null;
}): JSX.Element {
  return (
    <div className="posture-row">
      <BudgetCard monthInsights={monthInsights} today={activity?.burn.today ?? null} />
      <AnomalyCard activity={activity} win={win} days={days} />
    </div>
  );
}

function BudgetCard({ monthInsights, today }: { monthInsights: InsightsResult | null; today: string | null }): JSX.Element {
  const { mode } = useCostMode();
  const [budget, setBudget] = useState<number | null>(() => readBudget());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const monthDays: CostedDay[] = useMemo(() => {
    if (!monthInsights) return [];
    const byBucket = groupByBucket(monthInsights.dailySpend as BucketedCell[]);
    return [...byBucket].map(([bucket, cells]) => ({ day: bucket.slice(0, 10), cost: costOfBucketedCells(cells, mode) }));
  }, [monthInsights, mode]);

  const posture = useMemo(
    () => (today ? computeBudgetPosture(monthDays, today, budget) : null),
    [monthDays, today, budget],
  );
  const peakDay = useMemo(() => monthDays.reduce((mx, d) => Math.max(mx, d.cost), 0), [monthDays]);
  const activeDays = useMemo(() => monthDays.filter((d) => d.cost > 0).length, [monthDays]);
  const perActiveDay = activeDays ? (posture?.monthToDate ?? 0) / activeDays : 0;
  const monthName = today ? new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'long' }) : '';

  const saveBudget = () => {
    const n = Number(draft);
    const next = Number.isFinite(n) && n > 0 ? n : null;
    setBudget(next);
    try { if (next) localStorage.setItem(BUDGET_KEY, String(next)); else localStorage.removeItem(BUDGET_KEY); } catch { /* private mode */ }
    setEditing(false);
  };

  if (!posture) return <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  const share = posture.share;
  const fillPct = share != null ? Math.min(share * 100, 100) : 0;
  const projPct = budget && posture.projected ? Math.min((posture.projected / budget) * 100, 100) : null;

  return (
    <div className="card budget-card">
      <div className="sot-head">
        <h3>{t('Budget')} <span className="sub3">· {monthName} · {t('list price')}</span></h3>
        {!editing && (
          <button type="button" className="edit-aff" onClick={() => { setDraft(budget ? String(budget) : ''); setEditing(true); }}>✎ {t('edit')}</button>
        )}
      </div>
      {editing ? (
        <div className="budget-edit">
          <span className="muted small">{t('Monthly budget')} $</span>
          <input type="number" min="0" step="1" value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveBudget(); if (e.key === 'Escape') setEditing(false); }} />
          <button type="button" className="mini-btn" onClick={saveBudget}>{t('Save')}</button>
          <button type="button" className="mini-btn ghost" onClick={() => setEditing(false)}>{t('Cancel')}</button>
        </div>
      ) : (
        <div className="budget-meter">
          {budget != null ? (
            <>
              <div className="bm-line">
                <span><b>{fmtMoney(posture.monthToDate, 0)}</b> {t('of')} {fmtMoney(budget, 0)} · {Math.round((share ?? 0) * 100)}% {posture.state && <span className={`stw ${posture.state.severity}`}>{t(posture.state.word)}</span>}</span>
                {posture.projected != null && <b className="proj-lbl">≈ {fmtMoney(posture.projected, 0)} {t('month-end')}</b>}
              </div>
              <div className="budget-track">
                <div className="bt-fill" style={{ width: `${fillPct}%` }} />
                {projPct != null && <div className="bt-proj" style={{ left: `${projPct}%` }} />}
              </div>
            </>
          ) : (
            <div className="bm-line">
              <span><b>{fmtMoney(posture.monthToDate, 0)}</b> <span className="muted">{t('month to date')}</span></span>
              <span className="muted small">{t('no budget set')}</span>
            </div>
          )}
          <div className="bm-sub muted">
            {fmtMoney(posture.perDayPace, 2)}/{t('day pace')} · {t('peak day')} {fmtMoney(peakDay, 0)} · {fmtMoney(perActiveDay, 2)}/{t('active-day')}
            {budget == null && posture.projected != null && <> · {t('on pace for')} ≈{fmtMoney(posture.projected, 0)}</>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Anomaly card: the deep-view sibling of the Overview tile. Same math
// (window-scoped ratio + top project/model movers + flagged days + Lane-C). ----
function AnomalyCard({ activity, win, days }: { activity: ActivityResult | null; win: RangeKey; days: number | null }): JSX.Element {
  const { mode } = useCostMode();
  const burn = activity?.burn ?? null;
  const costedDays = useMemo(() => (burn ? buildCostedDays(burn, mode) : []), [burn, mode]);
  const flaggedDays = useMemo(
    () => (burn ? computeFlaggedDays(costedDays, burn.today, DEFAULT_SPEND_THRESHOLDS.anomaly, windowStartDay(burn.today, days) ?? undefined) : []),
    [burn, costedDays, days],
  );

  if (!activity || !burn) return <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>;

  const winStart = windowStartDay(burn.today, days);
  // Headline: window spend vs baseline (same as the tile). current = window-sum
  // of the costed days; baseline = the server prior-period cells priced (latest
  // rate, matching the tile's priceCells).
  const current = costedDays
    .filter((d) => (winStart ? d.day >= winStart : true) && d.day <= burn.today)
    .reduce((s, d) => s + d.cost, 0);
  let baseline = 0;
  for (const [model, cell] of Object.entries(burn.baselineTokensByModel)) baseline += costOf(model, cell, undefined, mode) ?? 0;
  const hasBaseline = baseline > 0;
  const ratio = hasBaseline ? current / baseline : null;
  const hot = ratio != null && ratio > 2;
  const topProject = topDimInWindow(costedDays, burn.today, winStart, 'project');
  const topModel = topDimInWindow(costedDays, burn.today, winStart, 'model');
  const laneCToday = burn.laneCByDay[burn.today] ?? 0;
  const showFlagged = win !== 'today' && flaggedDays.length > 0;

  return (
    <div className={`card anom-card ${hot ? 'warn' : ''}`}>
      <div className="eyebrow">{t('Anomaly')} · {t(WIN_LABEL[win])} {t('window')} <InfoTip text={t(LANE_C_UNATTRIBUTED_DEFINITION)} /></div>
      <div className="ac-headline">
        {ratio != null
          ? <>×{ratio.toFixed(1)}{hot && <span className="burn-flag"> {t('high')}</span>} <span className="muted small">{fmtMoney(current, 0)} {t('vs')} {fmtMoney(baseline, 0)}</span></>
          : <>{fmtMoney(current, current < 1 ? 2 : 0)} <span className="muted small">{t('this window · no baseline')}</span></>}
      </div>
      {(topProject || topModel) && (
        <div className="anom-mover">
          {topProject && <span><span className="anom-glyph">{MOVER_GLYPH.project}</span> <span className="muted">{t('top project')} </span><b>{topProject.value}</b> {fmtMoney(topProject.cost, topProject.cost < 1 ? 2 : 0)}</span>}
          {topProject && topModel && <span className="anom-sep"> · </span>}
          {topModel && <span><span className="anom-glyph">{MOVER_GLYPH.model}</span> <span className="muted">{t('top model')} </span><b>{topModel.value}</b> {fmtMoney(topModel.cost, topModel.cost < 1 ? 2 : 0)}</span>}
        </div>
      )}
      {laneCToday > 0 && (
        <div className="anom-lanec">{t('incl.')} {fmtMoney(laneCToday, 2)} {t('proxy lane, not attributable to a mover')}</div>
      )}
      {showFlagged && (
        <div className="anom-flagged-static">{flaggedDays.length} {flaggedDays.length === 1 ? t('flagged day') : t('flagged days')}{t(' in window')}</div>
      )}
    </div>
  );
}

// ---- Spend by model hbar (same math as the Overview card) ----
function SpendByModelCard({ insights, win }: { insights: InsightsResult | null; win: RangeKey }): JSX.Element {
  const { mode } = useCostMode();
  const rows = useMemo(() => {
    if (!insights) return [];
    const byModel = groupByKey(insights.windowedTokensByModel, (c) => c.model);
    return [...byModel.entries()]
      .map(([name, cells]) => ({ name, value: costOfBucketedCells(cells, mode) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [insights, mode]);
  const max = rows[0]?.value || 1;
  return (
    <div className="card">
      <h3>{t('Spend by model')} <span className="sub3">· {t(WIN_LABEL[win])}</span></h3>
      {rows.map((r, i) => (
        <div className="hbar" key={r.name}>
          <span className="n" title={r.name}>{r.name}</span>
          <div className="track"><div className="seg" style={{ width: `${(r.value / max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
          <span className="v num">{fmtMoney(r.value, 0)}</span>
        </div>
      ))}
      {!rows.length && <div className="muted small pad8">{t('No spend in range.')}</div>}
    </div>
  );
}

// ---- Proxy lane slim row (authoritative billed $, not session-linked, D8) ----
function ProxyLaneRow({ insights }: { insights: InsightsResult | null }): JSX.Element | null {
  const laneC = insights?.laneC;
  if (!laneC || laneC.totalSpend <= 0) return null;
  // Sub-cent proxy spend renders "<$0.01" rather than a misleading "$0.00".
  const costLabel = laneC.totalSpend < 0.005 ? `<${fmtMoney(0.01, 2)}` : fmtMoney(laneC.totalSpend, 2);
  return (
    <div className="card proxy-lane-row">
      <span className="eyebrow">{t('Proxy lane (billed)')}</span>
      <span className="pl-cost num-col">{costLabel}</span>
      <span className="muted small">litellm · {t('authoritative $ · not session-linked')} · {laneC.requests} {t('req')}</span>
    </div>
  );
}

function PlaceholderCard({ title, sub, note }: { title: string; sub?: string; note: string }): JSX.Element {
  return (
    <div className="card">
      <h3>{title}{sub ? <span className="sub3"> · {sub}</span> : null}</h3>
      <div className="muted small pad8">{note}</div>
    </div>
  );
}
