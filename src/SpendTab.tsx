import React, { useMemo, useState, type JSX } from 'react';
import type { InsightsResult, ActivityResult, ExploreResult, ExploreRow, DetectorCounts } from './api.js';
import { insightsUrl, exploreUrl, detectorsUrl } from './api.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { useCostMode } from './costMode.tsx';
import { costOfBucketedCells, groupByBucket, groupByKey, type BucketedCell } from './windowedUsage.ts';
import { fmtMoney, fmtInt } from './format.js';
import { t } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import type { RangeKey } from './RangeBar.tsx';
import SpendOverTime from './insights/SpendOverTime.tsx';
import { rowSpend } from './ExploreTab.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import type { CostedDay } from '../shared/spend/anomaly.ts';
import { computeBudgetPosture } from '../shared/spend/budget.ts';
import { MCP_DOUBLE_COUNT_DEFINITION, DEFAULT_SPEND_THRESHOLDS, gradeCacheHit, gradeShareLowerBetter, type StateWord } from '../shared/spend/thresholds.ts';

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
      <EfficiencyCard insights={insights} win={win} days={days} />
      <SkillsMcpRow win={win} days={days} />
      <ProxyLaneRow insights={insights} />
    </div>
  );
}

function BudgetBand({ monthInsights, today }: { monthInsights: InsightsResult | null; today: string | null }): JSX.Element {
  const { mode } = useCostMode();
  const [budget, setBudget] = useState<number | null>(() => readBudget());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Days of the CURRENT calendar month only. The month-insights fetch reaches
  // back day-of-month days, which crosses into the last day of the PRIOR month
  // (e.g. Aug 27 → 27 days back → Jul 31); filtering to the `YYYY-MM-` prefix
  // keeps peak-day / active-day honest (computeBudgetPosture already filters MTD
  // internally, but peak/active are computed here).
  const monthPrefix = today ? today.slice(0, 8) : '';
  const monthDays: CostedDay[] = useMemo(() => {
    if (!monthInsights) return [];
    const byBucket = groupByBucket(monthInsights.dailySpend as BucketedCell[]);
    return [...byBucket]
      .map(([bucket, cells]) => ({ day: bucket.slice(0, 10), cost: costOfBucketedCells(cells, mode) }))
      .filter((d) => d.day.startsWith(monthPrefix));
  }, [monthInsights, mode, monthPrefix]);

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
        <span className="eyebrow">{t('Budget')} · {monthName} · {t('list price')} <InfoTip text={t('The budget is always the current calendar month, independent of the window toggle above. Month-to-date, projection, and the pace / peak-day / per-active-day stats are all for this month.')} /></span>
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

// ---- Efficiency (CHI-324 2e), pass 1: DETECTORS. Four rows graded by the
// shared state-words (cache hit rate, jumbo outputs, long context, error rows).
// Cache-hit + error-rate derive from /api/insights; jumbo + long-context from
// the per-message /api/detectors slice. Waste signals + routing compliance are
// pass 2. ----
interface DetectorRow { name: string; pct: number; state: StateWord; barPct: number; def: string }

function EfficiencyCard({ insights, win, days }: { insights: InsightsResult | null; win: RangeKey; days: number | null }): JSX.Element {
  const { data: det } = useCachedFetch<DetectorCounts>(detectorsUrl(days));
  const th = DEFAULT_SPEND_THRESHOLDS;

  const rows = useMemo<DetectorRow[]>(() => {
    if (!det) return [];
    const out: DetectorRow[] = [];
    // Cache hit rate — higher is better.
    const cacheDenom = det.cacheReadTokens + det.inputTokens;
    if (cacheDenom > 0) {
      const rate = det.cacheReadTokens / cacheDenom;
      out.push({ name: t('Cache hit rate'), pct: rate * 100, state: gradeCacheHit(rate, th.stateWords), barPct: rate * 100, def: t('input tokens served from the prompt cache') });
    }
    // Jumbo outputs — share of assistant outputs past the jumbo threshold.
    if (det.assistantRows > 0) {
      const share = det.jumboRows / det.assistantRows;
      out.push({ name: t('Jumbo outputs'), pct: share * 100, state: gradeShareLowerBetter(share, th.stateWords.jumboHealthyMax), barPct: Math.min(share * 100, 100), def: t('share of outputs past 3k tokens') });
      // Long context — share of assistant turns fed over the long-context threshold.
      const lc = det.longContextRows / det.assistantRows;
      out.push({ name: t('Long context'), pct: lc * 100, state: gradeShareLowerBetter(lc, th.stateWords.longContextHealthyMax), barPct: Math.min(lc * 100, 100), def: t('share of turns fed over 150k tokens') });
    }
    // Error rows — assistant rows that recorded an API error (from insights).
    if (insights) {
      const head = insights.errorsByProject.reduce((s, r) => s + r.head_count, 0);
      const errs = insights.errorsByProject.reduce((s, r) => s + r.error_count, 0);
      if (head > 0) {
        const rate = errs / head;
        out.push({ name: t('Error rows'), pct: rate * 100, state: gradeShareLowerBetter(rate, th.stateWords.errorHealthyMax), barPct: Math.min(rate * 100, 100), def: t('assistant rows that recorded an API error') });
      }
    }
    return out;
  }, [det, insights, th]);

  return (
    <div className="card">
      <div className="eff-head">
        <h3 style={{ margin: 0 }}>{t('Efficiency')} <span className="sub3">· {t(WIN_LABEL[win])}</span></h3>
        <span className="muted small">{t('whole scan')}</span>
      </div>
      <div className="eff-sub">— {t('detectors')}</div>
      {rows.map((r) => (
        <div className="eff-row" key={r.name}>
          <span className="eff-n">{r.name}</span>
          <span className="eff-v">{r.pct < 1 ? r.pct.toFixed(2) : r.pct.toFixed(1)}%</span>
          <span className="eff-w"><span className={`sw ${r.state.severity}`}>{t(r.state.word)}</span></span>
          <div className="track"><div className={`seg sev-${r.state.severity}`} style={{ width: `${r.barPct}%` }} /></div>
          <span className="eff-d muted">{r.def}</span>
        </div>
      ))}
      {!rows.length && <div className="muted small pad8">{t('Loading…')}</div>}
      <div className="eff-sub">— {t('waste signals · routing compliance')}</div>
      <div className="muted small pad8">{t('Building next — right-sizing, cache churn, repeat file reads, and on/off-roster routing.')}</div>
    </div>
  );
}

// ---- Priced skills | MCP server spend (CHI-324 2b section 5) — both from the
// Explore engine (client prices tokensByModel). MCP is calibrated + double-counts
// (one turn can hit several servers), so its total does not sum to the day (D6). ----
function tokensOfRow(row: ExploreRow): number {
  let n = 0;
  for (const u of Object.values(row.tokensByModel)) n += u.input + u.output + u.cacheRead + u.cw5m + u.cw1h;
  return n;
}
function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function SkillsMcpRow({ win, days }: { win: RangeKey; days: number | null }): JSX.Element {
  const { mode } = useCostMode();
  const { data: skillRes } = useCachedFetch<ExploreResult>(exploreUrl({ scope: 'all', metric: 'spend', group: 'skill', days }));
  const { data: mcpRes } = useCachedFetch<ExploreResult>(exploreUrl({ scope: 'all', metric: 'spend', group: 'mcp', days }));

  const skills = useMemo(() => (skillRes?.rows ?? [])
    .map((r) => ({ name: r.label, runs: r.requests, tokens: tokensOfRow(r), cost: rowSpend(r, undefined, mode) }))
    .sort((a, b) => b.cost - a.cost).slice(0, 8), [skillRes, mode]);
  const mcp = useMemo(() => (mcpRes?.rows ?? [])
    .map((r) => ({ name: r.label, cost: rowSpend(r, undefined, mode) }))
    .sort((a, b) => b.cost - a.cost).slice(0, 8), [mcpRes, mode]);
  const mcpMax = mcp[0]?.cost || 1;

  return (
    <div className="grid2">
      <div className="card">
        <h3>{t('Priced skills')} <span className="sub3">· {t(WIN_LABEL[win])}</span> <InfoTip text={t('Calibrated estimate: a turn’s spend is attributed to the skills and slash-commands it invoked, so a command that mostly sets up an expensive turn (e.g. /model) can carry a large figure. Read it as exposure, not a partition of spend.')} /></h3>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('Skill')}</th>
              <th>{t('Runs')}</th>
              <th>{t('Tokens')}</th>
              <th>{t('Cost')} <span className="sort-car" aria-hidden="true">▾</span></th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name}>
                <td style={{ textAlign: 'left' }}>{s.name}</td>
                <td>{fmtInt(s.runs)}</td>
                <td>{fmtTok(s.tokens)}</td>
                <td className="cost">{fmtMoney(s.cost, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!skills.length && <div className="muted small pad8">{t('No skill spend in range.')}</div>}
      </div>
      <div className="card">
        <h3>{t('MCP server spend')} <span className="sub3">· {t(WIN_LABEL[win])}</span> <InfoTip text={t(MCP_DOUBLE_COUNT_DEFINITION)} /></h3>
        {mcp.map((r, i) => (
          <div className="hbar" key={r.name}>
            <span className="n" title={r.name}>{r.name}</span>
            <div className="track"><div className="seg" style={{ width: `${(r.cost / mcpMax) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
            <span className="v num">{fmtMoney(r.cost, 2)}</span>
          </div>
        ))}
        {!mcp.length && <div className="muted small pad8">{t('No MCP spend in range.')}</div>}
        {mcp.length > 0 && <div className="muted small pad8">{t('A call can fan out to several servers — rows double-count and do not sum to the day total.')}</div>}
      </div>
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
