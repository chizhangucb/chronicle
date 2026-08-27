import React, { useMemo, useState, type JSX } from 'react';
import type { InsightsResult, ActivityResult } from './api.js';
import { insightsUrl } from './api.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { useCostMode } from './costMode.tsx';
import { costOfBucketedCells, groupByBucket, groupByKey, type BucketedCell } from './windowedUsage.ts';
import { fmtMoney } from './format.js';
import { t } from './i18n.js';
import type { RangeKey } from './RangeBar.tsx';
import SpendOverTime from './insights/SpendOverTime.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import type { CostedDay } from '../shared/spend/anomaly.ts';
import { computeBudgetPosture } from '../shared/spend/budget.ts';

// The Spend tab (CHI-324 2b/2d/2e/2f) — the deep spend view. Reading order:
// posture row (Budget + Anomaly) → chart row (spend-over-time + spend-by-model)
// → plan windows → efficiency → skills/MCP → proxy lane. This increment ships
// the posture row, chart row, and proxy lane; the three server-backed sections
// (plan windows = quota reads, efficiency = detectors/roster, skills/MCP =
// explore spend) land next. Chronicle's grammar; Varde content only.

const WIN_LABEL: Record<RangeKey, string> = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', all: 'All' };
const BUDGET_KEY = 'chronicle.monthlyBudget';
// Synthetic pseudo-model rows carry 0 real tokens — excluded from spend views.
const PSEUDO_MODELS = new Set(['<synthetic>']);

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
      {/* Budget is a full-width horizontal band (CHI-324 review): the anomaly is
          already the Overview tile, so the Spend tab shows budget alone up top,
          laid out horizontally so it fills the row with no empty half. */}
      <BudgetBand monthInsights={monthInsights} today={today} />
      <div className="grid2">
        {insights ? <SpendOverTime result={insights} /> : <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>}
        <SpendBreakdownCard insights={insights} win={win} />
      </div>
      <PlaceholderCard title={t('Plan windows')} sub={t('per account')} note={t('Building next — one card per account (Claude 5h / 7d / top-tier · Codex 7d), quota-read, Settings opt-out.')} />
      <PlaceholderCard title={t('Efficiency')} note={t('Building next — detectors (cache hit · jumbo · long context · error rows), waste signals, and routing compliance.')} />
      <PlaceholderCard title={t('Priced skills & MCP spend')} note={t('Building next — skill and per-server spend from the Explore engine.')} />
      <ProxyLaneRow insights={insights} />
    </div>
  );
}

function BudgetBand({ monthInsights, today }: { monthInsights: InsightsResult | null; today: string | null }): JSX.Element {
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
    <div className="card budget-band">
      <div className="bb-head">
        <span className="eyebrow">{t('Budget')} · {monthName} · {t('list price')}</span>
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
        <div className="bb-body">
          <div className="bb-num">
            <span className="bb-mtd">{fmtMoney(posture.monthToDate, 0)}</span>
            {budget != null
              ? <span className="bb-cap muted">{t('of')} {fmtMoney(budget, 0)} · {Math.round((share ?? 0) * 100)}%{posture.state && <> <span className={`stw ${posture.state.severity}`}>{t(posture.state.word)}</span></>}</span>
              : <span className="bb-cap muted">{t('month to date')} · {t('no budget set')}</span>}
          </div>
          {budget != null && (
            <div className="bb-meter">
              <div className="budget-track">
                <div className="bt-fill" style={{ width: `${fillPct}%` }} />
                {projPct != null && <div className="bt-proj" style={{ left: `${projPct}%` }} />}
              </div>
              {posture.projected != null && <div className="bb-proj-lbl muted small">{t('projected')} ≈ {fmtMoney(posture.projected, 0)} {t('month-end')}</div>}
            </div>
          )}
          <div className="bb-stats muted">
            <span>{fmtMoney(posture.perDayPace, 2)}<span className="bb-unit">/{t('day pace')}</span></span>
            <span>{t('peak day')} {fmtMoney(peakDay, 0)}</span>
            <span>{fmtMoney(perActiveDay, 2)}<span className="bb-unit">/{t('active-day')}</span></span>
            {budget == null && posture.projected != null && <span>{t('on pace for')} ≈{fmtMoney(posture.projected, 0)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Anomaly card: the deep-view sibling of the Overview tile. Same math
// (window-scoped ratio + top project/model movers + flagged days + Lane-C). ----
// ---- Spend breakdown card: Spend by model ($) + Sources (session count by
// tool vendor), stacked so this card matches the spend chart's height. Sources
// moved here from Overview (CHI-324 review) — it pairs with the $ breakdown. ----
function SpendBreakdownCard({ insights, win }: { insights: InsightsResult | null; win: RangeKey }): JSX.Element {
  const { mode } = useCostMode();
  const rows = useMemo(() => {
    if (!insights) return [];
    const byModel = groupByKey(insights.windowedTokensByModel, (c) => c.model);
    return [...byModel.entries()]
      .filter(([name]) => !PSEUDO_MODELS.has(name)) // drop $0 synthetic pseudo-model
      .map(([name, cells]) => ({ name, value: costOfBucketedCells(cells, mode) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [insights, mode]);
  const sources = useMemo(() => {
    if (!insights) return [];
    const m = new Map<string, number>();
    for (const s of insights.sessions) m.set(s.source, (m.get(s.source) ?? 0) + 1);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [insights]);
  const max = rows[0]?.value || 1;
  const srcMax = sources[0]?.value || 1;
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
      <h3>{t('Sources')}</h3>
      {sources.map((r, i) => (
        <div className="hbar" key={r.name}>
          <span className="n" title={r.name}>{r.name}</span>
          <div className="track"><div className="seg" style={{ width: `${(r.value / srcMax) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
          <span className="v num">{r.value}</span>
        </div>
      ))}
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
