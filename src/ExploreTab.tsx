import React, { useMemo, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { BarChart, Bar, Brush, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { exploreUrl, type ExploreResult, type ExploreRow, type ExploreCell, type ExploreQueryParams, type ExploreRollup } from './api.ts';
import { t, lang } from './i18n.ts';
import InfoTip from './InfoTip.tsx';
import { CATEGORICAL_COLORS } from './colors.ts';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from './charts/ChartWrapper.tsx';
import { costOf } from './models.ts';
import { fmtMoney } from './format.ts';
import { fmtHourOfDay, densifyBuckets, capDenseBuckets, type BucketUnit } from './charts/timeBuckets.ts';
import { bucketLabel } from '@shared/bucketLabel.ts';
import PivotControls, {
  type PivotState, type PivotMetric, type PivotRollup, metricOptions, groupOptions,
} from './explore/PivotControls.tsx';
import { groupShowsTokenColumn } from './explore/tokenColumns.ts';
import { useCachedFetch } from './useCachedFetch.ts';

// Mounted by both HomeDashboard (the Home hub, scope {type:all}) and ProjectDetail
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

// ---- Local formatters. Money uses the shared `fmtMoney` from format.ts
// (grouped thousands): 0dp for the large-magnitude BAR labels (aligns with
// Insights Overview "Spend by model") and 2dp only in the Detail table (EXP-03).
function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}
function fmtHours(ms: number): string {
  return (ms / 3600000).toFixed(1);
}

// Format a subgroup label value based on the subgroup type. For hour subgroups,
// formats the hour number (0–23) as "9 AM" / "10 PM"; for others, returns the
// label as-is. If no label is available (subgroupLabelByKey miss), falls back to
// the key itself.
function fmtSubgroupLabel(key: string, label: string | undefined, subgroup: string): string {
  const displayLabel = label ?? key;
  if (subgroup === 'hour') {
    return fmtHourOfDay(displayLabel, lang());
  }
  return displayLabel;
}

// These read only the metric-agnostic aggregate fields, so they accept either a
// range-total ExploreRow or a per-bucket ExploreCell (ExploreRow is a superset).
// Sum of a cell's billed input+output tokens across every model it touched.
function rowTokens(row: ExploreCell): number {
  let n = 0;
  for (const u of Object.values(row.tokensByModel)) n += u.input + u.output;
  return n;
}

// Client-side pricing (never a server call, never a hardcoded price — see
// CLAUDE.md § Cost is computed locally). Sums costOf(model, …) per model
// cell, mapping ModelUsageCell's cw5m/cw1h field names to ModelUsageInput's
// cacheWrite5m/cacheWrite1h; costOf returns null for unpriced models, which
// contributes 0 rather than poisoning the sum.
function rowSpend(row: ExploreCell): number {
  let n = 0;
  for (const [model, u] of Object.entries(row.tokensByModel)) {
    n += costOf(model, {
      input: u.input, output: u.output, cacheRead: u.cacheRead,
      cacheWrite5m: u.cw5m, cacheWrite1h: u.cw1h,
    }) ?? 0;
  }
  return n;
}

function metricValue(row: ExploreCell, metric: PivotMetric): number {
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

// `moneyDp` controls Spend precision: 0dp for ranked-bar labels (default),
// 2dp for the Detail table's metric column (EXP-03).
function fmtMetricValue(row: ExploreRow, metric: PivotMetric, moneyDp: 0 | 2 = 0): string {
  switch (metric) {
    case 'spend': return fmtMoney(rowSpend(row), moneyDp);
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
  // Same query-param construction as before (now pure — `exploreUrl` just
  // stringifies it); the fetch/cache/error lifecycle moved into
  // `useCachedFetch`, which renders cached data for this exact URL
  // immediately (e.g. flipping Metric/Group back to a combo already visited)
  // instead of the old `setResult(null)`-on-every-change blank.
  const params: ExploreQueryParams = {
    scope: scope.type, id: scope.id, days: days ?? undefined,
    metric: pivot.metric, group: pivot.group,
    // 'none' is a UI-only sentinel (ExploreQueryParams has no 'none' subgroup)
    // — omit the param. Also omit while a rollup is active: the time-series
    // stack already carries the group series (Subgroup is disabled in the UI).
    subgroup: pivot.subgroup === 'none' || pivot.rollup !== 'total' ? undefined : pivot.subgroup,
    topN: pivot.topN,
    rollup: pivot.rollup,
  };
  const { data: result } = useCachedFetch<ExploreResult>(exploreUrl(params));

  // days<1 (e.g. fractional days-since-local-midnight for "Today") reads as
  // "Today" rather than a fractional day count like "0.9960218055555555D".
  const rangeLabel = days == null ? t('All') : days < 1 ? t('Today') : `${Math.round(days)}d`;
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

  // ---- Time-rollup chart (rollup !== 'total') ----
  const ROLLUP_LABEL: Record<PivotRollup, string> = {
    total: t('Total'), hourly: t('Hourly'), daily: t('Daily'), weekly: t('Weekly'), monthly: t('Monthly'),
  };
  // Series colour by ranked index — the SAME mapping the Detail table dots use,
  // so a series' bar-segment colour matches its table row. 'Other' is always
  // `--ink-3` (never a rotating categorical hue) — it's a fold-in bucket, not
  // an identity, so it must read as visually distinct/recessive rather than
  // competing with the real top-N series for attention (dataviz "color
  // follows the entity" rule: a non-entity fold-in gets the neutral ink, not
  // a slot in the categorical rotation).
  const rowColor = (row: ExploreRow, i: number): string =>
    row.key === 'Other' ? 'var(--ink-3)' : CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
  // "<synthetic>" is Claude Code's placeholder model tag for client-generated
  // assistant turns that never hit the API — connection errors, rate-limit
  // notices, "no response requested" (VALIDATION GATE, Task 17: verified
  // against real ~/.claude/projects/*/*.jsonl — every sampled row carries
  // input_tokens/output_tokens/cache_*=0, so it never contributes to
  // rowSpend/rowTokens; this is display-only, no cost-math change needed).
  // Relabeled here rather than server-side so the raw model group key stays a
  // faithful passthrough of the source data.
  const rowDisplayLabel = (row: ExploreRow): string =>
    (pivot.group === 'model' && row.key === '<synthetic>') ? t('client-generated') : row.label;
  // Server bucket-key unit per effective rollup, for densifyBuckets. 'total'
  // never reaches here (result.buckets is undefined for it).
  const ROLLUP_UNIT: Record<Exclude<ExploreRollup, 'total'>, BucketUnit> = {
    hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month',
  };
  // Defensive cap on the dense-filled series (review finding #1): hourly
  // never coarsens server-side, so an hourly rollup over a multi-year "All"
  // range densifies to tens of thousands of rows (verified: an 11-year span
  // → 101,821 entries) — unsafe to feed wholesale into <BarChart>/<Brush>.
  // Keep the most RECENT MAX_DENSE_BUCKETS and say so via a card-subtitle
  // note (same visual pattern as the "too dense — showing <coarser>" note
  // just above this chart).
  const MAX_DENSE_BUCKETS = 2000;
  // One Recharts row per bucket: { bucket: label, [seriesKey]: metricValue }.
  // Series set = the ranked rows (topN + Other), so the stack matches the
  // table. D12: server/explore.ts only returns buckets that have data, so a
  // long idle gap used to collapse to equal spacing between distant buckets,
  // misrepresenting time. Zero-fill from the earliest to the latest bucket
  // KEY (not label) via the shared densifyBuckets helper (Task 3), then look
  // up each dense key's real bucket if present — a missing one renders as an
  // all-zero row with a label formatted the SAME way the server would have
  // (shared/bucketLabel.ts), so a gap bar looks identical in style to a real
  // one, just empty. capDenseBuckets then bounds the result to the most
  // recent MAX_DENSE_BUCKETS keys.
  const rollupChart = useMemo(() => {
    if (!result?.buckets) return { rows: [] as Record<string, string | number>[], truncated: false, total: 0 };
    const byKey = new Map(result.buckets.map((b) => [b.bucket, b]));
    const unit = ROLLUP_UNIT[result.rollup as Exclude<ExploreRollup, 'total'>];
    const denseKeys = densifyBuckets(result.buckets.map((b) => b.bucket), unit);
    const capped = capDenseBuckets(denseKeys, MAX_DENSE_BUCKETS);
    const rows = capped.keys.map((key) => {
      const b = byKey.get(key);
      const row: Record<string, string | number> = { bucket: b ? b.label : bucketLabel(key) };
      for (const { row: r } of ranked) {
        const cell = b?.series[r.key];
        row[r.key] = cell ? metricValue(cell, pivot.metric) : 0;
      }
      return row;
    });
    return { rows, truncated: capped.truncated, total: capped.total };
  }, [result, ranked, pivot.metric]);
  const chartData = rollupChart.rows;
  // Recharts <Brush> default window for the hourly rollup — hourly never
  // coarsens server-side any more (see server/explore.ts), so a wide range
  // can return hundreds/thousands of buckets; the brush keeps the plot
  // legible by defaulting to the last 72 (~3 days) while leaving the full
  // series draggable. Clamped to 0 so a short series (< 72 buckets) just
  // shows everything, no negative startIndex.
  const brushStartIndex = Math.max(0, chartData.length - 72);
  const brushEndIndex = Math.max(0, chartData.length - 1);
  // daily/weekly/monthly are normally kept legible by server-side cap
  // coarsening (COUNT(DISTINCT bucket) over the buckets that actually HAVE
  // data — see server/explore.ts's cap-coarsening comment), which is why they
  // historically never needed a brush. But that cap is computed pre-densify:
  // a sparse range (e.g. 20 active days spread across a full year) can still
  // pass the sparse cap and then balloon once dense-filled with the empty
  // days/weeks/months in between. Reuse the same brush for that edge case
  // rather than leaving those rollups unbounded once dense.
  const DENSE_BRUSH_THRESHOLD = 90; // mirrors server/explore.ts ROLLUP_BUCKET_CAP
  const showBrush = chartData.length > 0
    && (result?.rollup === 'hourly' || chartData.length > DENSE_BRUSH_THRESHOLD);
  const otherRow = ranked.find(({ row }) => row.key === 'Other');
  const fmtChartValue = (v: number): string => {
    if (pivot.metric === 'spend') return fmtMoney(v, 0);
    if (pivot.metric === 'tokens') return fmtTok(v);
    if (pivot.metric === 'active') return `${fmtHours(v)}h`;
    return Math.round(v).toLocaleString();
  };

  const canRowLink = scope.type === 'project' && scope.id != null;
  const rowLinkTitle = canRowLink ? undefined : t('Filtered session list coming soon');

  // EXP-01: the Detail table renders a dynamic metric column AND fixed
  // Tokens/Requests/Sessions columns. When the selected metric IS one of those
  // three, the metric column is an exact duplicate — drop the leading metric
  // column for those (Spend/Active/Errors have no fixed twin, so it stays).
  const FIXED_COLUMN_KEYS = new Set(['Tokens', 'Requests', 'Sessions']);
  const showMetricCol = !FIXED_COLUMN_KEYS.has(METRIC_COLUMN_KEY[pivot.metric]);
  // EXP-02: suppress the TOKENS column to '—' only for the truly-calibrated
  // groups (tool/skill), whose card carries the ≈ badge. model/project/source
  // (authoritative) AND subagent/hour (real per-message tokens, shown unmarked
  // on the card/bar) show the concrete number. $/session is SPEND-derived and is
  // NOT gated here — it shows for every group (see tokenColumns.ts).
  const showTokenCol = groupShowsTokenColumn(pivot.group);

  return (
    <>
      <PivotControls value={pivot} onChange={setPivot} />
      {!result ? (
        <div className="muted pad8">{t('Loading…')}</div>
      ) : (
        <>
          <div className="card">
            <h3>
              {result.buckets
                ? `${metricChipLabel} ${t('by')} ${groupChipLabel} · ${ROLLUP_LABEL[result.rollup]} · ${rangeLabel}`
                : cardTitle}
              {result.calibrated && (
                <>
                  {' ≈'}
                  <InfoTip text={t('Estimated from message text length, scaled to billed totals — tool/skill token attribution is approximate.')} />
                </>
              )}
              {result.rollup !== result.requestedRollup && (
                <span className="muted small"> · {ROLLUP_LABEL[result.requestedRollup]} {t('too dense — showing')} {ROLLUP_LABEL[result.rollup]}</span>
              )}
              {rollupChart.truncated && (
                <span className="muted small">
                  {' '}· {t('showing the most recent')} {MAX_DENSE_BUCKETS.toLocaleString()} {t('of')} {rollupChart.total.toLocaleString()} {t('buckets')}
                </span>
              )}
            </h3>
            {result.buckets ? (
              chartData.length ? (
                <>
                  <ResponsiveContainer width="100%" height={showBrush ? 280 : 240}>
                    <BarChart data={chartData}>
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="bucket" {...AXIS_PROPS} />
                      <YAxis {...AXIS_PROPS} width={52} tickFormatter={(v) => fmtChartValue(Number(v))} />
                      <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} formatValue={(v) => fmtChartValue(Number(v))} calibrated={result.calibrated} />} />
                      {ranked.map(({ row }, i) => (
                        <Bar key={row.key} dataKey={row.key} stackId="a" name={rowDisplayLabel(row)} fill={rowColor(row, i)} />
                      ))}
                      {showBrush && (
                        <Brush
                          dataKey="bucket"
                          height={24}
                          travellerWidth={8}
                          startIndex={brushStartIndex}
                          endIndex={brushEndIndex}
                          stroke="var(--brass)"
                          fill="var(--bg2)"
                        />
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="legend">
                    {ranked.filter(({ row }) => row.key !== 'Other').map(({ row }, i) => (
                      <span key={row.key}><span className="dot" style={{ background: rowColor(row, i) }} />{rowDisplayLabel(row)}</span>
                    ))}
                    {otherRow && (
                      <span style={{ color: 'var(--ink-3)' }}>
                        <span className="dot" style={{ background: 'var(--ink-3)' }} />
                        + {otherRow.row.otherCount ?? ''} {t('in Other')}
                      </span>
                    )}
                  </div>
                </>
              ) : <div className="muted small pad8">{t('No sessions in range.')}</div>
            ) : (
              <>
                {ranked.map(({ row, value }) => {
                  const totalBarPct = (value / maxValue) * 100;
                  const segTotal = row.segments.reduce((n, s) => n + s.tokens, 0);
                  return (
                    <div className="rank" key={row.key}>
                      <span className="n" title={rowDisplayLabel(row)}>{rowDisplayLabel(row)}</span>
                      <div className="track">
                        {row.segments.length > 0 && segTotal > 0
                          ? row.segments.map((seg) => {
                            const fmtLabel = fmtSubgroupLabel(seg.key, seg.label, pivot.subgroup);
                            return (
                              <i
                                key={seg.key}
                                title={`${fmtLabel}: ${fmtTok(seg.tokens)}`}
                                style={{ width: `${(seg.tokens / segTotal) * totalBarPct}%`, background: segColor(seg.key) }}
                              />
                            );
                          })
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
                    {subgroupKeys.slice(0, CATEGORICAL_COLORS.length).map((key) => {
                      const label = fmtSubgroupLabel(key, subgroupLabelByKey.get(key), pivot.subgroup);
                      return (
                        <span key={key}><span className="dot" style={{ background: segColor(key) }} />{label}</span>
                      );
                    })}
                    {subgroupKeys.length > CATEGORICAL_COLORS.length && (
                      <span style={{ color: 'var(--ink-3)' }}>
                        <span className="dot" style={{ background: 'var(--ink-3)' }} />
                        + {subgroupKeys.length - CATEGORICAL_COLORS.length} {t('more')}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h3>{t('Detail')}</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('Group')}</th>
                  {showMetricCol && <th>{t(METRIC_COLUMN_KEY[pivot.metric])}</th>}
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
                  // group=session rows carry the session id as `key` — link
                  // straight to that session's own view, independent of the
                  // project-scope-only fallback below ('Other' has no single
                  // session id, so it stays unclickable). Takes precedence
                  // over the project-scope link since it's strictly more
                  // specific (one session, not "coming soon" filtered list).
                  const isSessionRow = pivot.group === 'session' && row.key !== 'Other';
                  const rowClickable = isSessionRow || canRowLink;
                  const onRowClick = isSessionRow
                    ? () => navigate(`/session/${encodeURIComponent(row.key)}`)
                    : (canRowLink ? () => navigate(`/project/${scope.id}`) : undefined);
                  return (
                    <tr key={row.key}
                      className={rowClickable ? 'rowlink' : ''}
                      title={isSessionRow ? undefined : rowLinkTitle}
                      onClick={onRowClick}
                    >
                      <td><span className="dot" style={{ background: rowColor(row, i) }} />{rowDisplayLabel(row)}</td>
                      {showMetricCol && <td className="cost">{fmtMetricValue(row, pivot.metric, 2)}</td>}
                      <td><span className="mini"><i style={{ width: `${Math.min(100, share)}%`, background: rowColor(row, i) }} /></span> {share.toFixed(1)}%</td>
                      <td>{showTokenCol ? fmtTok(rowTokens(row)) : '—'}</td>
                      <td>{row.requests.toLocaleString()}</td>
                      <td>{row.sessions.toLocaleString()}</td>
                      <td>{fmtMoney(perSession, 2)}</td>
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
