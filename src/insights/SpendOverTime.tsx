import React, { useMemo, useState, type JSX } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { InsightsResult } from '../api.js';
import {
  costOfCells, costOfBucketedCells, groupByKey, groupByBucket, sumByKeyModel, type BucketedCell,
} from '../windowedUsage.ts';
import { densifyBuckets, capDenseBuckets, fmtDayLabel, fmtHourLabel } from '../charts/timeBuckets.ts';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from '../charts/ChartWrapper.tsx';
import { CATEGORICAL_COLORS, projectColorMap } from '../colors.ts';
import { fmtMoney } from '../format.js';
import { t, lang } from '../i18n.js';
import { useCostMode } from '../costMode.tsx';
import { providerOf, PROVIDER_ORDER, type Provider } from '../../shared/provider.ts';

// Spend-over-time stacked bar with a bare [project | provider] stack toggle and
// a quiet median dash on the same y-scale (CHI-324 2d). Shared by the Overview
// tab (InsightsCharts) and the Spend tab so the two charts cannot drift. Title
// stays "Spend over time" (name + window only); NO flagged-day markers — the
// anomaly tile carries flags. `provider` = model VENDOR (anthropic/openai/
// google), NOT `source` (that is the tool vendor, the Sources chart). Prices
// every bucket at its own day's rate (CHI-228) and honors the List/Billed
// toggle.

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
function localeOf(): string { return INTL_LOCALE[lang()] ?? 'en-US'; }

const MAX_DENSE_BUCKETS = 2000;
type Stack = 'project' | 'provider';

interface Series { key: string; name: string; color: string }

export default function SpendOverTime({ result }: { result: InsightsResult }): JSX.Element {
  const { mode } = useCostMode();
  // Default option sits far left (design-QA rubric): project.
  const [stack, setStack] = useState<Stack>('project');

  const projectColors = useMemo(() => projectColorMap(result.projects.map((p) => p.id)), [result]);

  // Top 5 projects by windowed spend + Other (project stack).
  const { topProjects, otherProjectIds } = useMemo(() => {
    const byProject = groupByKey(result.windowedTokensByModel, (c) => String(c.projectId));
    const spend = new Map<number, number>();
    for (const [key, cells] of byProject) spend.set(Number(key), costOfBucketedCells(cells, mode));
    const sorted = [...result.projects].sort((a, b) => (spend.get(b.id) ?? 0) - (spend.get(a.id) ?? 0));
    return { topProjects: sorted.slice(0, 5), otherProjectIds: new Set(sorted.slice(5).map((p) => p.id)) };
  }, [result, mode]);

  // Providers present in range, in the fixed categorical order (provider stack).
  const presentProviders = useMemo(() => {
    const present = new Set<Provider>();
    for (const c of result.windowedTokensByModel) present.add(providerOf(c.model));
    return PROVIDER_ORDER.filter((p) => present.has(p));
  }, [result]);

  const series: Series[] = useMemo(() => {
    if (stack === 'provider') {
      return presentProviders.map((p) => ({ key: p, name: p, color: CATEGORICAL_COLORS[PROVIDER_ORDER.indexOf(p) % CATEGORICAL_COLORS.length] }));
    }
    const s: Series[] = topProjects.map((p, i) => ({ key: String(p.id), name: p.name, color: projectColors.get(p.id) ?? CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }));
    if (otherProjectIds.size) s.push({ key: 'other', name: t('Other'), color: 'var(--ink-3)' });
    return s;
  }, [stack, presentProviders, topProjects, otherProjectIds, projectColors]);

  const useHourly = result.hourlySpend != null;
  const bucketUnit = useHourly ? 'hour' as const : 'day' as const;

  const groupKeyOf = (c: BucketedCell): string =>
    stack === 'provider' ? providerOf(c.model) : (otherProjectIds.has(c.projectId) ? 'other' : String(c.projectId));

  const chartData = useMemo(() => {
    const cells = (useHourly ? result.hourlySpend! : result.dailySpend) as BucketedCell[];
    const byBucket = groupByBucket(cells);
    // Dense-fill so equal bar spacing = equal time (D12), capped to avoid runaway.
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

  return (
    <div className="card">
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
          <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => fmtMoney(v, 0)} />
          <Tooltip content={(p) => <ChartTooltip {...(p as unknown as Parameters<typeof ChartTooltip>[0])} formatValue={(v) => fmtMoney(Number(v), 2)} />} />
          {median != null && (
            <ReferenceLine y={median} stroke="var(--ink-3)" strokeDasharray="4 3" strokeWidth={1}
              label={{ value: `${t('median')} ${fmtMoney(median, median < 1 ? 2 : 0)}`, position: 'insideTopLeft', fill: 'var(--ink-3)', fontSize: 10 }} />
          )}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="a" name={s.name} fill={s.color} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <div className="legend">
        {series.filter((s) => s.key !== 'other').map((s) => (
          <span key={s.key}><span className="dot" style={{ background: s.color }} />{s.name}</span>
        ))}
        {stack === 'project' && otherProjectIds.size > 0 && (
          <span style={{ color: 'var(--ink-3)' }}>+ {otherProjectIds.size} {t('in Other')}</span>
        )}
      </div>
    </div>
  );
}
