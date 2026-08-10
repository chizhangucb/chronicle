import React, { type JSX } from 'react';
import type { TooltipContentProps } from 'recharts';
import { CATEGORICAL_COLORS } from '../colors.ts';

// The one Recharts wrapper module (design spec, "Charts" primitive): every
// chart in the app should compose Recharts' own <LineChart>/<BarChart>/etc.
// with these shared pieces so every chart reads as one system — categorical
// palette order, mono ticks, --border grid, and the OpenRouter-style
// breakdown tooltip. No call sites yet; 5d wires real per-view charts.

// Categorical series palette — fixed order, never cycled (same source as the
// --c1..--c5 CSS tokens and src/colors.ts, so pills/dots/charts never drift
// apart). 6th+ series folds into "Other" (the caller's job to pre-aggregate
// before charting).
export const CHART_COLORS = CATEGORICAL_COLORS;

// Shared axis styling — spread onto Recharts' <XAxis>/<YAxis>.
export const AXIS_PROPS = {
  tick: { fontSize: 10, fontFamily: 'var(--mono)', fill: 'var(--ink-3)' },
  axisLine: { stroke: 'var(--border)' },
  tickLine: { stroke: 'var(--border)' },
};

// Shared grid styling — spread onto Recharts' <CartesianGrid>.
export const GRID_PROPS = { stroke: 'var(--border)', vertical: false };

// The design spec's "Chart interaction spec": date header, one row per
// series (color tick · name · value, sorted desc, zero-series omitted), a
// Total row separated by a rule when more than one series is present.
// Pass as Recharts' <Tooltip content={<ChartTooltip formatValue={...} />} />.
export interface ChartTooltipProps<V extends number = number> extends TooltipContentProps<V, string> {
  formatValue?: (v: V) => string;
}

export function ChartTooltip<V extends number = number>(
  { active, label, payload, formatValue = (v) => String(v) }: ChartTooltipProps<V>,
): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const rows = payload
    .filter((p) => Number(p.value ?? 0) !== 0)
    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
  if (!rows.length) return null;
  const total = rows.reduce((s, p) => s + Number(p.value ?? 0), 0);
  return (
    <div className="tooltip">
      {label != null && <div className="tt-date">{label}</div>}
      {rows.map((p, i) => (
        <div key={i} className="tt-row">
          <span>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: String(p.color), marginRight: 6 }} />
            {p.name}
          </span>
          <b>{formatValue((p.value ?? 0) as V)}</b>
        </div>
      ))}
      {rows.length > 1 && (
        <div className="tt-row tt-total">
          <span>Total</span>
          <b>{formatValue(total as V)}</b>
        </div>
      )}
    </div>
  );
}
