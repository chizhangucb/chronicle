import React, { useMemo, useState, type JSX } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { InsightsResult } from '../api.js';
import {
  costOfCells, costOfBucketedCells, groupByKey, groupByBucket, sumByKeyModel, type BucketedCell,
} from '../rangedUsage.ts';
import { densifyBuckets, capDenseBuckets, fmtDayLabel, fmtHourLabel } from '../charts/timeBuckets.ts';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from '../charts/ChartWrapper.tsx';
import { CATEGORICAL_COLORS } from '../colors.ts';
import { fmtMoney } from '../format.js';
import { t, lang } from '../i18n.js';
import { useCostMode } from '../costMode.tsx';
import { providerOf, PROVIDER_ORDER, type Provider } from '../../shared/provider.ts';

// Spend-over-time stacked bar with a bare [project | provider] stack toggle and
// a quiet median dash on the same y-scale. Shared by the Overview
// tab (InsightsCharts) and the Spend tab so the two charts cannot drift. Title
// stays "Spend over time" (name + range only); NO flagged-day markers — the
// anomaly tile carries flags. `provider` = model VENDOR (anthropic/openai/
// google), NOT `source` (that is the tool vendor, the Sources chart). Prices
// every bucket at its own day's rate and honors the List/Billed
// toggle.

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
function localeOf(): string { return INTL_LOCALE[lang()] ?? 'en-US'; }

const MAX_DENSE_BUCKETS = 2000;
type Stack = 'project' | 'provider';
// Pseudo-models carry no real spend (synthetic events with 0 tokens) — never a
// meaningful spend series, so they're kept out of the model-vendor stack.
const PSEUDO_MODELS = new Set(['<synthetic>']);
// A visible neutral for the aggregated "Other" bucket, distinct from the five
// categorical hues and legible on both themes (ink-3 was too dim to see).
const OTHER_COLOR = 'var(--ink-2)';

interface Series { key: string; name: string; color: string }

export default function SpendOverTime({ result }: { result: InsightsResult }): JSX.Element {
  const { mode } = useCostMode();
  // Default option sits far left (design-QA rubric): project.
  const [stack, setStack] = useState<Stack>('project');

  // Top 5 projects by windowed spend + Other (project stack).
  const { topProjects, otherProjectIds } = useMemo(() => {
    const byProject = groupByKey(result.rangedTokensByModel, (c) => String(c.projectId));
    const spend = new Map<number, number>();
    for (const [key, cells] of byProject) spend.set(Number(key), costOfBucketedCells(cells, mode));
    const sorted = [...result.projects].sort((a, b) => (spend.get(b.id) ?? 0) - (spend.get(a.id) ?? 0));
    return { topProjects: sorted.slice(0, 5), otherProjectIds: new Set(sorted.slice(5).map((p) => p.id)) };
  }, [result, mode]);

  // Providers present in range, in the fixed categorical order (provider stack).
  // Pseudo-models are excluded so a $0 synthetic bucket never adds a phantom
  // "other" vendor to the legend.
  const presentProviders = useMemo(() => {
    const present = new Set<Provider>();
    for (const c of result.rangedTokensByModel) if (!PSEUDO_MODELS.has(c.model)) present.add(providerOf(c.model));
    return PROVIDER_ORDER.filter((p) => present.has(p));
  }, [result]);

  // Series get their color by RANK (distinct-by-construction from the 5-hue
  // palette), NOT by the app-wide per-project identity color — that one is
  // assigned by project id, so two different top-5-by-spend projects could land
  // on the same hue (two top-5 projects collided in review).
  const series: Series[] = useMemo(() => {
    if (stack === 'provider') {
      return presentProviders.map((p) => ({ key: p, name: p, color: CATEGORICAL_COLORS[PROVIDER_ORDER.indexOf(p) % CATEGORICAL_COLORS.length] }));
    }
    return topProjects.map((p, i) => ({ key: String(p.id), name: p.name, color: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }));
  }, [stack, presentProviders, topProjects]);

  const useHourly = result.hourlySpend != null;
  const bucketUnit = useHourly ? 'hour' as const : 'day' as const;

  const groupKeyOf = (c: BucketedCell): string => {
    if (stack === 'provider') return PSEUDO_MODELS.has(c.model) ? '__pseudo' : providerOf(c.model);
    return otherProjectIds.has(c.projectId) ? 'other' : String(c.projectId);
  };

  const chartData = useMemo(() => {
    const cells = (useHourly ? result.hourlySpend! : result.dailySpend) as BucketedCell[];
    const byBucket = groupByBucket(cells);
    // Dense-fill so equal bar spacing = equal time, capped to avoid runaway.
    const denseKeys = densifyBuckets([...byBucket.keys()], bucketUnit);
    const { keys: bucketKeys } = capDenseBuckets(denseKeys, MAX_DENSE_BUCKETS);
    const labelOf = (k: string) => (useHourly ? fmtHourLabel(k, localeOf()) : fmtDayLabel(k, localeOf()));
    return bucketKeys.map((bucket) => {
      const byGroupModel = sumByKeyModel(byBucket.get(bucket) ?? [], groupKeyOf);
      const day = bucket.slice(0, 10); // every cell in this bucket shares one pricing day
      const row: Record<string, string | number> = { bucket: labelOf(bucket) };
      let total = 0;
      for (const [key, byModel] of byGroupModel) { const c = costOfCells(byModel, day, mode); row[key] = c; total += c; }
      row.__total = total;
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, stack, otherProjectIds, useHourly, bucketUnit, mode]);

  // Median of the ACTIVE buckets' totals (matches the anomaly baseline notion),
  // drawn as a quiet dash on the same y-scale.
  const median = useMemo(() => {
    const totals = chartData.map((r) => Number(r.__total)).filter((v) => v > 0).sort((a, b) => a - b);
    if (totals.length < 2) return null;
    const mid = Math.floor(totals.length / 2);
    return totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
  }, [chartData]);

  // Show the aggregated Other bar + legend only when it actually carries spend
  // (project stack only) — never advertise "+N in Other" with no visible bar.
  const hasOtherSpend = stack === 'project' && chartData.some((r) => Number(r.other) > 0);

  return (
    <div className="card sot-card">
      <div className="sot-head">
        <h3>{t('Spend over time')}{useHourly ? ` · ${t('Hourly')}` : ''}</h3>
        <div className="stack-toggle" role="group" aria-label={t('Stack by')}>
          <button type="button" className={`st-opt ${stack === 'project' ? 'on' : ''}`} onClick={() => setStack('project')}>{t('project')}</button>
          <button type="button" className={`st-opt ${stack === 'provider' ? 'on' : ''}`} onClick={() => setStack('provider')}>{t('provider')}</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="bucket" {...AXIS_PROPS} />
          {/* Fixed width so the plot area starts at the same x on every window,
              regardless of tick-label magnitude ($140 vs $1,000) — review: charts looked different widths across windows. */}
          <YAxis {...AXIS_PROPS} width={52} tickFormatter={(v: number) => fmtMoney(v, 0)} />
          <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} formatValue={(v) => fmtMoney(Number(v), 2)} />} />
          {median != null && (
            <ReferenceLine y={median} stroke="var(--ink-3)" strokeDasharray="4 3" strokeWidth={1}
              label={{ value: `${t('median')} ${fmtMoney(median, median < 1 ? 2 : 0)}`, position: 'insideTopLeft', fill: 'var(--ink-3)', fontSize: 10 }} />
          )}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="a" name={s.name} fill={s.color} />
          ))}
          {hasOtherSpend && <Bar dataKey="other" stackId="a" name={t('Other')} fill={OTHER_COLOR} />}
        </BarChart>
      </ResponsiveContainer>
      <div className="legend">
        {series.map((s) => (
          <span key={s.key}><span className="dot" style={{ background: s.color }} />{s.name}</span>
        ))}
        {hasOtherSpend && (
          <span><span className="dot" style={{ background: OTHER_COLOR }} />{t('Other')} (+{otherProjectIds.size})</span>
        )}
      </div>
    </div>
  );
}
