import React, { useEffect, useMemo, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api, type InsightsResult, type InsightsSessionRow } from './api.ts';
import { sessionDisplayName } from './ProjectDetail.jsx';
import { t, lang } from './i18n.ts';
import InfoTip from './InfoTip.tsx';
import WorkingRhythm from './insights/WorkingRhythm.tsx';
import { CATEGORICAL_COLORS, projectColorMap } from './colors.ts';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from './charts/ChartWrapper.tsx';
import { costOf, type ModelUsageInput } from './models.ts';

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
function localeOf(): string { return INTL_LOCALE[lang()] ?? 'en-US'; }

const RANGES: { key: string; days: number | null }[] = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'All', days: null },
];

// ---- Local formatters (mirrors src/ProjectDetail.tsx's fmtDur/fmtTok style
// — kept local rather than shared, since that file isn't in this task's
// touch list). ----
function fmtMoney(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`;
}
function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}
function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtHours(ms: number): string {
  return (ms / 3600000).toFixed(1);
}
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
// "Tokens" = input + output only (matches ProjectDetail.tsx's `totalTokens`
// and OverviewMode.tsx's `costAgg.totalTokens`) — cache read/write are a
// separate billing tier, shown via the cache-hit-rate stats and the "Token
// usage by model" table's own cacheRead/cw5m/cw1h columns, so narrowing this
// doesn't hide any information. Deduped at the 5d Wave-2 integration pass:
// Insights previously included cache tokens here, which made its "Tokens" KPI
// mean something different from the same-named KPI on the other two views.
function sessionTokens(json: string | null): number {
  let total = 0;
  for (const u of Object.values(parseUsage(json))) {
    total += (u.input || 0) + (u.output || 0);
  }
  return total;
}

export default function InsightsPage(): JSX.Element {
  const [, navigate] = useLocation();
  const [days, setDays] = useState<number | null>(30);
  const [result, setResult] = useState<InsightsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.insights(days ?? undefined).then((r) => { if (!cancelled) setResult(r); }).catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [days]);

  const rangeLabel = days ? `${days}d` : t('All');

  const projectById = useMemo(() => new Map(result?.projects.map((p) => [p.id, p.name]) ?? []), [result]);
  const projectColors = useMemo(() => projectColorMap((result?.projects ?? []).map((p) => p.id)), [result]);

  // ---- KPI aggregates ----
  const kpis = useMemo(() => {
    if (!result) return null;
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

  // ---- Spend over time · stacked by project (client-side, per the days= range) ----
  // Which 5 projects get an individual bar is chosen by TOTAL SPEND in range
  // (descending), matching how "Spend by model"/"Sources" below already rank
  // by value — NOT by project id, so a newer high-spend project doesn't get
  // silently folded into "Other" behind older low-spend ones. Color
  // ASSIGNMENT (`projectColors` below) stays id-sorted via `projectColorMap`
  // on purpose, so a project's color stays stable across views regardless of
  // which projects happen to rank in the top 5 here.
  const projectSpend = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of result?.sessions ?? []) {
      const cost = sessionCost(s.usage);
      if (!cost) continue;
      m.set(s.project_id, (m.get(s.project_id) ?? 0) + cost);
    }
    return m;
  }, [result]);
  const projectsBySpend = useMemo(
    () => [...(result?.projects ?? [])].sort((a, b) => (projectSpend.get(b.id) ?? 0) - (projectSpend.get(a.id) ?? 0)),
    [result, projectSpend],
  );
  const topProjects = useMemo(() => projectsBySpend.slice(0, 5), [projectsBySpend]);
  const otherProjectIds = useMemo(() => new Set(projectsBySpend.slice(5).map((p) => p.id)), [projectsBySpend]);
  const spendChartData = useMemo(() => {
    if (!result) return [];
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
    if (!result) return [];
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
    if (!result) return [];
    const m = new Map<string, number>();
    for (const s of result.sessions) m.set(s.source, (m.get(s.source) ?? 0) + 1);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [result]);

  // ---- Global tool mix (top 5 + Other) ----
  const toolMix = useMemo(() => {
    if (!result) return [];
    const top = result.toolDist.slice(0, 5).map((r) => ({ name: r.name, value: r.count }));
    const rest = result.toolDist.slice(5).reduce((n, r) => n + r.count, 0);
    return rest ? [...top, { name: t('Other'), value: rest }] : top;
  }, [result]);

  // ---- Error rate by project (top 6) ----
  const errorRateByProject = useMemo(() => {
    if (!result) return [];
    return result.errorsByProject
      .filter((r) => r.head_count > 0)
      .map((r) => ({ name: projectById.get(r.project_id) ?? `#${r.project_id}`, value: (r.error_count / r.head_count) * 100 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [result, projectById]);

  // ---- Token usage by model table ----
  const tokenTable = useMemo(() => {
    if (!result) return [];
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
    if (!result) return [];
    return result.sessions
      .map((s) => ({ session: s, cost: sessionCost(s.usage), tokens: sessionTokens(s.usage) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 15);
  }, [result]);

  if (!result || !kpis) {
    return <div className="page"><div className="muted pad8">{t('Loading…')}</div></div>;
  }

  return (
    <div className="page insights-page">
      <div className="head"><h1>{t('Insights')}</h1><span className="sub">{t('all projects · all sources')}</span></div>
      <div className="ctlrow">
        <div className="rangebar">
          {RANGES.map((r) => (
            <button key={r.key} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>
              {r.days ? `${r.days}d` : t('All')}
            </button>
          ))}
        </div>
      </div>

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
          <div className="l">{t('Agent active')} <InfoTip text={t('Time the agent was working: every inter-message gap counts except the gap leading into a genuine typed human prompt. Background waits (builds, notifications) count as active.')} /></div>
          <div className="v">{fmtHours(kpis.agentActiveMs)}<span className="u">h</span></div>
          <div className="s">{fmtActive(kpis.agentActiveMs)}</div>
        </div>
        <div className="kpi">
          <div className="l">{t('Your engaged')} <InfoTip text={t("Your attention time: gaps around your typed prompts and interactions, capped so idle walk-aways don't inflate it. Leverage = agent-active ÷ engaged.")} /></div>
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
      </div>

      <div className="grid2">
        <div className="card">
          <h3>{t('Spend over time · stacked by project')}</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendChartData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="day" {...AXIS_PROPS} />
              <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} formatValue={(v) => `$${Number(v).toFixed(2)}`} />} />
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
                <span className="v num">{r.value.toLocaleString()}</span>
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
                <td>{r.msgs.toLocaleString()}</td>
                <td className="cost">{fmtMoney(r.cost)}</td>
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
              <td>{tokenTotals.msgs.toLocaleString()}</td>
              <td className="cost">{fmtMoney(tokenTotals.cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>{t('Top sessions by cost')} · {rangeLabel}</h3>
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
                <td className="cost">{fmtMoney(cost)}</td>
                <td>{fmtTok(tokens)}</td>
                <td>{fmtActive(session.agent_active_ms || 0)}</td>
                <td>{session.started_at ? fmtDayLabel(session.started_at.slice(0, 10)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!topSessions.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
      </div>
    </div>
  );
}

// Re-exported for test/eslint clarity if another module ever needs the row
// shape (no current external call site — InsightsPage owns its own table
// rendering).
export type { InsightsSessionRow };
