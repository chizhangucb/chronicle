import React, { useEffect, useMemo, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { api, type ExploreResult, type ExploreRow, type ExploreQueryParams } from './api.ts';
import { t } from './i18n.ts';
import InfoTip from './InfoTip.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import { costOf } from './models.ts';
import PivotControls, {
  type PivotState, type PivotMetric, metricOptions, groupOptions,
} from './explore/PivotControls.tsx';

// Mounted by both InsightsPage (5e-1, scope {type:'all'}) and ProjectDetail
// (5e-4, scope {type:'project', id}) — kept generic from day one so 5e-4
// doesn't need a second pass on this file.
export interface Scope {
  type: 'all' | 'project' | 'session';
  id?: number | string;
}

export interface ExploreTabProps {
  scope: Scope;
  days: number | null;
}

// ---- Local formatters (mirrors InsightsPage.tsx's file-local fmtMoney/
// fmtTok/fmtHours — kept local rather than shared per that file's own note).
function fmtMoney(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`;
}
function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}
function fmtHours(ms: number): string {
  return (ms / 3600000).toFixed(1);
}

// Sum of a row's billed input+output tokens across every model it touched.
function rowTokens(row: ExploreRow): number {
  let n = 0;
  for (const u of Object.values(row.tokensByModel)) n += u.input + u.output;
  return n;
}

// Client-side pricing (never a server call, never a hardcoded price — see
// CLAUDE.md § Cost is computed locally). Sums costOf(model, …) per model
// cell, mapping ModelUsageCell's cw5m/cw1h field names to ModelUsageInput's
// cacheWrite5m/cacheWrite1h; costOf returns null for unpriced models, which
// contributes 0 rather than poisoning the sum.
function rowSpend(row: ExploreRow): number {
  let n = 0;
  for (const [model, u] of Object.entries(row.tokensByModel)) {
    n += costOf(model, {
      input: u.input, output: u.output, cacheRead: u.cacheRead,
      cacheWrite5m: u.cw5m, cacheWrite1h: u.cw1h,
    }) ?? 0;
  }
  return n;
}

function metricValue(row: ExploreRow, metric: PivotMetric): number {
  switch (metric) {
    case 'spend': return rowSpend(row);
    case 'tokens': return rowTokens(row);
    case 'requests': return row.requests;
    case 'sessions': return row.sessions;
    case 'errors': return row.errors;
    case 'active': return row.activeMs;
    default: return 0;
  }
}

function fmtMetricValue(row: ExploreRow, metric: PivotMetric): string {
  switch (metric) {
    case 'spend': return fmtMoney(rowSpend(row));
    case 'tokens': return fmtTok(rowTokens(row));
    case 'requests': return row.requests.toLocaleString();
    case 'sessions': return row.sessions.toLocaleString();
    case 'errors': return row.errors.toLocaleString();
    case 'active': return `${fmtHours(row.activeMs)}h`;
    default: return '';
  }
}

const METRIC_COLUMN_KEY: Record<PivotMetric, string> = {
  spend: 'Spend', tokens: 'Tokens', requests: 'Requests',
  active: 'Active', sessions: 'Sessions', errors: 'Errors',
};

export default function ExploreTab({ scope, days }: ExploreTabProps): JSX.Element {
  const [, navigate] = useLocation();
  const [pivot, setPivot] = useState<PivotState>({
    metric: 'spend', group: 'model', subgroup: 'none', rollup: 'total', topN: 10,
  });
  const [result, setResult] = useState<ExploreResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    const params: ExploreQueryParams = {
      scope: scope.type, id: scope.id, days: days ?? undefined,
      metric: pivot.metric, group: pivot.group,
      // 'none' is a UI-only sentinel (ExploreQueryParams has no 'none' subgroup) — omit the param entirely.
      subgroup: pivot.subgroup === 'none' ? undefined : pivot.subgroup,
      topN: pivot.topN,
    };
    api.explore(params).then((r) => { if (!cancelled) setResult(r); }).catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [scope.type, scope.id, days, pivot.metric, pivot.group, pivot.subgroup, pivot.topN]);

  const rangeLabel = days ? `${days}d` : t('All');
  const metricChipLabel = useMemo(() => metricOptions().find((o) => o.key === pivot.metric)?.label ?? pivot.metric, [pivot.metric]);
  const groupChipLabel = useMemo(() => groupOptions().find((o) => o.key === pivot.group)?.label ?? pivot.group, [pivot.group]);
  const subgroupChipLabel = useMemo(
    () => (pivot.subgroup !== 'none' ? groupOptions().find((o) => o.key === pivot.subgroup)?.label ?? pivot.subgroup : null),
    [pivot.subgroup],
  );
  const cardTitle = `${metricChipLabel} ${t('by')} ${groupChipLabel}`
    + (subgroupChipLabel ? ` · ${t('subgrouped by')} ${subgroupChipLabel}` : '')
    + ` · ${rangeLabel}`;

  // Ranked bars: re-sort by the CLIENT's own metric value (server's sort is
  // only a rough magnitude proxy for spend — see explore.ts's `mag`), with
  // the server's 'Other' fold-in row always pinned last regardless of value.
  const ranked = useMemo(() => {
    if (!result) return [];
    const withValue = result.rows.map((row) => ({ row, value: metricValue(row, pivot.metric) }));
    const rest = withValue.filter((r) => r.row.key !== 'Other').sort((a, b) => b.value - a.value);
    const other = withValue.filter((r) => r.row.key === 'Other');
    return [...rest, ...other];
  }, [result, pivot.metric]);
  const maxValue = Math.max(1e-9, ...ranked.map((r) => r.value));
  const totalValue = ranked.reduce((n, r) => n + r.value, 0) || 1;

  // Stable per-subgroup-value color: rank subgroup values by their TOTAL
  // tokens across all rows (not per-row), so e.g. "chronicle" gets the same
  // dot color in every row's stacked segment and in the legend.
  const subgroupKeys = useMemo(() => {
    if (!result) return [];
    const totals = new Map<string, number>();
    for (const row of result.rows) {
      for (const seg of row.segments) totals.set(seg.key, (totals.get(seg.key) ?? 0) + seg.tokens);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }, [result]);
  const subgroupLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of result?.rows ?? []) for (const seg of row.segments) m.set(seg.key, seg.label);
    return m;
  }, [result]);
  const segColor = (key: string): string => {
    const idx = subgroupKeys.indexOf(key);
    return idx >= 0 && idx < CATEGORICAL_COLORS.length ? CATEGORICAL_COLORS[idx] : 'var(--ink-3)';
  };

  const canRowLink = scope.type === 'project' && scope.id != null;
  const rowLinkTitle = canRowLink ? undefined : t('Filtered session list coming soon');

  return (
    <>
      <PivotControls value={pivot} onChange={setPivot} />
      {!result ? (
        <div className="muted pad8">{t('Loading…')}</div>
      ) : (
        <>
          <div className="card">
            <h3>
              {cardTitle}
              {result.calibrated && (
                <>
                  {' ≈'}
                  <InfoTip text={t('Estimated from message text length, scaled to billed totals — tool/skill token attribution is approximate.')} />
                </>
              )}
            </h3>
            {ranked.map(({ row, value }) => {
              const totalBarPct = (value / maxValue) * 100;
              const segTotal = row.segments.reduce((n, s) => n + s.tokens, 0);
              return (
                <div className="rank" key={row.key}>
                  <span className="n">{row.label}</span>
                  <div className="track">
                    {row.segments.length > 0 && segTotal > 0
                      ? row.segments.map((seg) => (
                        <i key={seg.key} style={{ width: `${(seg.tokens / segTotal) * totalBarPct}%`, background: segColor(seg.key) }} />
                      ))
                      : <i style={{ width: `${totalBarPct}%`, background: 'var(--c1)' }} />}
                  </div>
                  <span className="v">{fmtMetricValue(row, pivot.metric)}</span>
                  <span className="p">{((value / totalValue) * 100).toFixed(1)}%</span>
                </div>
              );
            })}
            {!ranked.length && <div className="muted small">{t('No sessions in range.')}</div>}
            {subgroupChipLabel && subgroupKeys.length > 0 && (
              <div className="legend">
                {subgroupKeys.slice(0, CATEGORICAL_COLORS.length).map((key) => (
                  <span key={key}><span className="dot" style={{ background: segColor(key) }} />{subgroupLabelByKey.get(key) ?? key}</span>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>{t('Detail')}</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('Group')}</th>
                  <th>{t(METRIC_COLUMN_KEY[pivot.metric])}</th>
                  <th>{t('Share')}</th>
                  <th>{t('Tokens')}</th>
                  <th>{t('Requests')}</th>
                  <th>{t('Sessions')}</th>
                  <th>{t('$/session')}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(({ row, value }, i) => {
                  const share = (value / totalValue) * 100;
                  const perSession = row.sessions ? rowSpend(row) / row.sessions : 0;
                  return (
                    <tr key={row.key}
                      className={canRowLink ? 'rowlink' : ''}
                      title={rowLinkTitle}
                      onClick={canRowLink ? () => navigate(`/project/${scope.id}`) : undefined}
                    >
                      <td><span className="dot" style={{ background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} />{row.label}</td>
                      <td className="cost">{fmtMetricValue(row, pivot.metric)}</td>
                      <td><span className="mini"><i style={{ width: `${Math.min(100, share)}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></span> {share.toFixed(1)}%</td>
                      <td>{fmtTok(rowTokens(row))}</td>
                      <td>{row.requests.toLocaleString()}</td>
                      <td>{row.sessions.toLocaleString()}</td>
                      <td>{fmtMoney(perSession)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!ranked.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
          </div>
        </>
      )}
    </>
  );
}
