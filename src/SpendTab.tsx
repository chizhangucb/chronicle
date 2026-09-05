import React, { useEffect, useMemo, useState, type JSX } from 'react';
import type { InsightsResult, ActivityResult, ExploreResult, ExploreRow, DetectorCounts, WasteResult, RosterResult, PlanWindowsResult, AccountWindow, PlanAccount } from './api.js';
import { api, insightsUrl, exploreUrl, detectorsUrl, wasteUrl, routingUrl, planWindowsUrl } from './api.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { useCostMode } from './costMode.tsx';
import { costOf, pricingFor } from './models.js';
import { costOfBucketedCells, groupByBucket, groupByKey, type BucketedCell } from './windowedUsage.ts';
import { fmtMoney, fmtInt } from './format.js';
import { t } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import SortCaret from './SortCaret.tsx';
import type { RangeKey } from './RangeBar.tsx';
import SpendOverTime from './insights/SpendOverTime.tsx';
import { rowSpend } from './ExploreTab.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import type { CostedDay } from '../shared/spend/anomaly.ts';
import { computeBudgetPosture } from '../shared/spend/budget.ts';
import { DEFAULT_SPEND_THRESHOLDS, gradeCacheHit, gradeShareLowerBetter, type StateWord } from '../shared/spend/thresholds.ts';

// The Spend tab (CHI-324 2b/2d/2e/2f) — the deep spend view. Reading order:
// posture row (Budget + Anomaly) → chart row (spend-over-time + spend-by-model)
// → plan windows → efficiency → skills/MCP. Chronicle's grammar; Varde content
// only.

const WIN_LABEL: Record<RangeKey, string> = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', all: 'All' };
// Legacy home: the monthly budget used to live ONLY here (CHI-366 moved it
// server-side so every surface reads one number). Read once on mount to migrate
// an existing value up to /settings, then cleared.
const LEGACY_BUDGET_KEY = 'chronicle.monthlyBudget';
// Synthetic pseudo-model rows carry 0 real tokens — excluded from spend views.
const PSEUDO_MODELS = new Set(['<synthetic>']);

function readLegacyLocalBudget(): number | null {
  try { const v = localStorage.getItem(LEGACY_BUDGET_KEY); const n = v ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; }
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
      <PlanWindowsCard />
      <EfficiencyCard insights={insights} win={win} days={days} />
      <SkillsMcpRow win={win} days={days} />
    </div>
  );
}

function BudgetBand({ monthInsights, today }: { monthInsights: InsightsResult | null; today: string | null }): JSX.Element {
  const { mode } = useCostMode();
  // Budget is server-backed (CHI-366): load it from /settings on mount, and
  // migrate a pre-existing localStorage budget up ONCE so upgrading users don't
  // silently lose their cap. `loaded` gates the render so the band never flashes
  // "no budget set" before the settings fetch resolves.
  const [budget, setBudget] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.settings();
        let b = s.monthlyBudget;
        if (b == null) {
          const local = readLegacyLocalBudget();
          if (local != null) {
            try { const saved = await api.patchSettings({ monthlyBudget: local }); b = saved.monthlyBudget; } catch { b = local; }
            try { localStorage.removeItem(LEGACY_BUDGET_KEY); } catch { /* private mode */ }
          }
        }
        if (alive) { setBudget(b); setLoaded(true); }
      } catch {
        if (alive) setLoaded(true); // server unreachable → treat as no budget, still render
      }
    })();
    return () => { alive = false; };
  }, []);

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
    setBudget(next); // optimistic; the server is the source of truth
    api.patchSettings({ monthlyBudget: next }).then((s) => setBudget(s.monthlyBudget)).catch(() => { /* keep optimistic value */ });
    setEditing(false);
  };

  if (!posture || !loaded) return <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  const share = posture.share;
  const fillPct = share != null ? Math.min(share * 100, 100) : 0;
  const projPct = budget && posture.projected ? Math.min((posture.projected / budget) * 100, 100) : null;

  return (
    <div className="card budget-band">
      <div className="bb-head">
        <span className="eyebrow">{t('Budget')} · {monthName} · {t('list price')} <InfoTip def="spend.budget" /></span>
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
// (window-scoped ratio + top project/model movers + flagged days). ----
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

// ---- Plan windows (CHI-324 2f): one card per ACCOUNT. Codex is a LOCAL read
// (always); Claude is OUTBOUND + opt-in-off (D7) — the card shows an opt-in
// prompt until the user turns it on in Settings, then the live meters. ----
function fmtReset(iso: string | null, label: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Short (5h/current-session) windows show a clock; weekly windows show a day.
  return label === '5h'
    ? d.toLocaleTimeString('en-US', { hour: 'numeric' })            // "3 PM"
    : d.toLocaleDateString('en-US', { weekday: 'short' });          // "Thu"
}
function PlanWindowMeter({ w }: { w: AccountWindow }): JSX.Element {
  const pct = Math.max(0, Math.min(w.utilization, 100));
  const reset = fmtReset(w.resetsAt, w.label);
  return (
    <div className="pw-win">
      <span className="pw-l">{w.label}</span>
      <div className="track"><div className={`seg ${pct >= 90 ? 'sev-danger' : pct >= 75 ? 'sev-warn' : ''}`} style={{ width: `${pct}%`, background: pct < 75 ? 'var(--brass)' : undefined }} /></div>
      <span className="pw-v">{pct.toFixed(0)}%{reset ? ` · ${reset}` : ''}</span>
    </div>
  );
}
function AccountCard({ a }: { a: PlanAccount }): JSX.Element {
  return (
    <div className="acct">
      <div className="acct-head">
        <span className="acct-n">{a.name}{a.plan ? <span className="muted"> · {a.plan}</span> : null}</span>
        <span className="cov-tag">{t('covered')}</span>
      </div>
      {a.windows.map((w) => <PlanWindowMeter key={w.label} w={w} />)}
    </div>
  );
}

function PlanWindowsCard(): JSX.Element {
  const { data: pw } = useCachedFetch<PlanWindowsResult>(planWindowsUrl());
  const hasClaude = pw?.accounts.some((a) => a.kind === 'claude');
  return (
    <div className="card">
      <h3>{t('Plan windows')} <span className="sub3">· {t('per account')}</span></h3>
      {pw == null ? <div className="muted small pad8">{t('Loading…')}</div> : (
        <>
          {pw.accounts.length > 0 && <div className="acct-grid">{pw.accounts.map((a) => <AccountCard key={`${a.kind}:${a.name}`} a={a} />)}</div>}
          {!hasClaude && !pw.claudeEnabled && (
            <div className="muted small pad8">{t('Claude windows are turned off in Settings (they read your Claude 5h / 7d / Fable quota with one outbound call to api.anthropic.com, using Claude Code’s own token). Codex windows above are read locally. Re-enable in Settings.')}</div>
          )}
          {!hasClaude && pw.claudeUnauthed && (
            <div className="muted small pad8">{t('Claude windows are on but temporarily unavailable — no credentials found, or Anthropic’s usage endpoint is rate-limiting. Reloads on its own.')}</div>
          )}
          {pw.accounts.length > 0 && <div className="muted small pad8">{t('quota-read, not billed · Codex local · Claude via the usage endpoint (Settings opt-out).')}</div>}
        </>
      )}
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
  const { mode } = useCostMode();
  const { data: det } = useCachedFetch<DetectorCounts>(detectorsUrl(days));
  const { data: waste } = useCachedFetch<WasteResult>(wasteUrl(days));
  const { data: roster } = useCachedFetch<RosterResult>(routingUrl());
  const th = DEFAULT_SPEND_THRESHOLDS;

  // Routing compliance: classify the window's models on/off the hub roster
  // (family prefix), price each from the insights windowed cells.
  const routing = useMemo(() => {
    if (!roster?.present || !insights) return null;
    const byModel = groupByKey(insights.windowedTokensByModel, (c) => c.model);
    let onCost = 0; let total = 0;
    const off: { model: string; cost: number }[] = [];
    for (const [model, cells] of byModel) {
      if (PSEUDO_MODELS.has(model)) continue;
      const c = costOfBucketedCells(cells, mode);
      total += c;
      if (roster.families.some((f) => model.startsWith(f))) onCost += c;
      else if (c > 0) off.push({ model, cost: c });
    }
    off.sort((a, b) => b.cost - a.cost);
    return { onPct: total > 0 ? (onCost / total) * 100 : 100, off: off.slice(0, 4), offCost: off.reduce((s, o) => s + o.cost, 0) };
  }, [roster, insights, mode]);

  // Waste $ priced client-side from the shipped cells (the price table is
  // client-only). All at list price — these are "what could you save" estimates.
  const wasteRows = useMemo(() => {
    if (!waste) return null;
    // Cache churn: premium paid on cache writes in churn sessions (1h = 1x input
    // premium over base, 5m = 0.25x), summed per model.
    let churnCost = 0;
    for (const s of waste.cacheChurn.top) {
      for (const [model, c] of Object.entries(s.byModel)) {
        const p = pricingFor(model);
        if (p) churnCost += (c.cw1h * 1.0 * p.input + c.cw5m * 0.25 * p.input) / 1_000_000;
      }
    }
    // Right-sizing: premium-model small turns repriced at Sonnet — the estimated
    // saving. Premium = input rate >= threshold (fable/mythos, opus >= 4.5).
    const sonnet = pricingFor('claude-sonnet-5');
    let rsSavings = 0; let rsMessages = 0;
    if (sonnet) {
      for (const r of waste.rightSizing.candidates) {
        const p = pricingFor(r.model);
        if (!p || p.input < th.detectors.premiumInputRate) continue;
        const actual = costOf(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cw5m, cacheWrite1h: r.cw1h }) ?? 0;
        const repriced = (r.input * sonnet.input + r.output * sonnet.output + r.cacheRead * 0.1 * sonnet.input + r.cw1h * 2 * sonnet.input + r.cw5m * 1.25 * sonnet.input) / 1_000_000;
        const delta = actual - repriced;
        if (delta > 0) { rsSavings += delta; rsMessages += r.messages; }
      }
    }
    // Rereads: wasted re-read tokens re-sent as input, priced at Sonnet input.
    const rereadCost = sonnet ? (waste.rereads.estWastedTokens * sonnet.input) / 1_000_000 : 0;
    return {
      churnCost, churnSessions: waste.cacheChurn.sessionsFlagged,
      rsSavings, rsMessages,
      rereadCalls: waste.rereads.rereadCalls, rereadCost,
    };
  }, [waste, th]);

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

      <div className="eff-cols">
        <div>
          <div className="eff-sub">— {t('waste signals · estimates')} <InfoTip def="spend.waste" /></div>
          {wasteRows ? (
            <>
              <div className="waste-row"><span className="eff-n">{t('Right-sizing')}</span><span className="eff-v">≈{fmtMoney(wasteRows.rsSavings, 2)}</span><span className="muted small">{fmtInt(wasteRows.rsMessages)} {t('premium small turns')}</span></div>
              <div className="waste-row"><span className="eff-n">{t('Cache churn')}</span><span className="eff-v">{fmtMoney(wasteRows.churnCost, 2)}</span><span className="muted small">{fmtInt(wasteRows.churnSessions)} {t('sessions')}</span></div>
              <div className="waste-row"><span className="eff-n">{t('Repeat file reads')}</span><span className="eff-v">{fmtMoney(wasteRows.rereadCost, 2)}</span><span className="muted small">{fmtInt(wasteRows.rereadCalls)} {t('re-reads')}</span></div>
            </>
          ) : <div className="muted small pad8">{t('Loading…')}</div>}
        </div>
        <div>
          <div className="eff-sub">— {t('routing compliance')}</div>
          {roster == null ? <div className="muted small pad8">{t('Loading…')}</div>
            : !roster.present ? <div className="muted small pad8">{t('No roster — add governance/model-routing.md to your hub to track on/off-roster routing.')}</div>
            : routing ? (
              <div className="routing-body">
                <div className="routing-line">
                  <span className={`sw ${routing.onPct >= 90 ? 'ok' : routing.onPct >= 75 ? 'warn' : 'danger'}`}>{routing.onPct.toFixed(0)}% {t('on-roster')}</span>
                  {routing.off.length > 0 && <span className="muted"> · {t('off-roster')}: <b>{routing.off[0].model}</b> {fmtMoney(routing.off[0].cost, 2)}{routing.off.length > 1 ? ` +${routing.off.length - 1}` : ''}</span>}
                </div>
                <div className="muted small">{t('roster from your hub’s governance/model-routing.md')}{routing.off.length > 0 && <> · <span className="promote-aff">{t('Prepare promotion')}</span></>}</div>
              </div>
            ) : <div className="muted small pad8">{t('Loading…')}</div>}
        </div>
      </div>
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
    .map((r) => ({ name: r.label, calls: r.requests, tokens: tokensOfRow(r), cost: rowSpend(r, undefined, mode) }))
    .sort((a, b) => b.cost - a.cost).slice(0, 8), [mcpRes, mode]);

  return (
    <div className="grid2b">
      <div className="card">
        <h3>{t('Priced skills')} <span className="sub3">· {t(WIN_LABEL[win])}</span> <InfoTip def="spend.priced-skills" /></h3>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('Skill')}</th>
              <th>{t('Runs')}</th>
              <th>{t('Tokens')}</th>
              <th className="sort-on">{t('Cost')}<SortCaret on /></th>
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
        <h3>{t('MCP server spend')} <span className="sub3">· {t(WIN_LABEL[win])}</span></h3>
        {/* A table (not hbars) to match Priced skills AND because MCP spend spans
            orders of magnitude — the double-count inflates the top server so far
            that bars leave every other row an invisible sliver. Calls makes the
            double-count concrete. */}
        <table className="tbl mcp-table">
          <colgroup><col className="c-srv" /><col /><col /><col /></colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('Server')}</th>
              <th>{t('Calls')}</th>
              <th>{t('Tokens')}</th>
              <th className="sort-on"><InfoTip def="spend.mcp-exposure" /> {t('Turn $')}<SortCaret on /></th>
            </tr>
          </thead>
          <tbody>
            {mcp.map((r) => (
              <tr key={r.name}>
                <td className="mcp-srv" title={r.name}>{r.name}</td>
                <td>{fmtInt(r.calls)}</td>
                <td>{fmtTok(r.tokens)}</td>
                <td className="cost">{fmtMoney(r.cost, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mcp.length && <div className="muted small pad8">{t('No MCP spend in range.')}</div>}
        {mcp.length > 0 && <div className="muted small pad8">{t('A call can fan out to several servers — rows double-count and do not sum to the day total.')}</div>}
      </div>
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
