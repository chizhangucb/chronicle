import React, { type JSX } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ExploreQueryParams } from '../api.ts';

// PivotState mirrors ExploreQueryParams' metric/group/subgroup/topN, plus a
// UI-only `rollup` field (5e-0's server hardcodes rollup='total' — there is
// no `rollup` on ExploreQueryParams). `subgroup` carries the UI sentinel
// 'none' so a Radix chip always has a selectable value; ExploreTab maps
// 'none' -> undefined before calling api.explore.
export type PivotMetric = ExploreQueryParams['metric'];
export type PivotGroup = ExploreQueryParams['group'];
export type PivotSubgroup = PivotGroup | 'none';
export type PivotRollup = NonNullable<ExploreQueryParams['rollup']>;

export interface PivotState {
  metric: PivotMetric;
  group: PivotGroup;
  subgroup: PivotSubgroup;
  rollup: PivotRollup;
  topN: number;
}

export interface PivotControlsProps {
  value: PivotState;
  onChange: (next: PivotState) => void;
}

interface Option<T extends string | number> {
  key: T;
  label: string;
  enabled?: boolean;
  title?: string;
}

// Exported so ExploreTab can reuse the exact same label text for the ranked-
// bars card title / detail table without re-deriving it (avoids label drift
// between the pivot chip and the rest of the page).
export function metricOptions(): Option<PivotMetric>[] {
  return [
    { key: 'spend', label: 'Spend ($)' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'requests', label: 'Requests' },
    { key: 'active', label: 'Active time' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'errors', label: 'Errors' },
  ];
}

export function groupOptions(): Option<PivotGroup>[] {
  return [
    { key: 'model', label: 'Model' },
    { key: 'project', label: 'Project' },
    { key: 'source', label: 'Source' },
    { key: 'tool', label: 'Tool' },
    { key: 'skill', label: 'Skill' },
    { key: 'subagent', label: 'Subagent' },
    { key: 'hour', label: 'Hour' },
    { key: 'session', label: 'Session' },
  ];
}

function subgroupOptions(): Option<PivotSubgroup>[] {
  // 'session' is excluded here (unlike every other group value) because
  // subgroup segments are labeled by their raw group value (server/explore.ts
  // never resolves them through the name/summary/first_prompt fallback the
  // way the top-level group=session row label is) — stacking a bar by raw
  // session UUIDs would put unreadable ids in the segment legend, a DISTINCT/
  // AFFORD regression. Task 16 only asked for Session as a top-level Group.
  return [{ key: 'none', label: 'None' }, ...groupOptions().filter((o) => o.key !== 'session')];
}

function rollupOptions(): Option<PivotRollup>[] {
  return [
    { key: 'total', label: 'Total' },
    { key: 'hourly', label: 'Hourly' },
    { key: 'daily', label: 'Daily' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' },
  ];
}

const TOPN_OPTIONS: Option<number>[] = [5, 10, 20, 50].map((n) => ({ key: n, label: String(n) }));

// One pivot chip: a Radix DropdownMenu styled as `.pv` (label eyebrow +
// current value + caret). Markup/pattern copied from App.tsx's language
// switcher so styling matches exactly.
function PvChip<T extends string | number>({
  label, options, current, onSelect, disabled, disabledTitle,
}: {
  label: string;
  options: Option<T>[];
  current: T;
  onSelect: (key: T) => void;
  disabled?: boolean;
  disabledTitle?: string;
}): JSX.Element {
  const currentLabel = options.find((o) => o.key === current)?.label ?? String(current);
  // Whole-chip disable (e.g. Subgroup while a time rollup is active — the stack
  // already carries the group series). Render a static button, no dropdown.
  if (disabled) {
    return (
      <button type="button" className="pv" disabled title={disabledTitle}>
        <span className="lbl">{label}</span> {currentLabel} <span className="car">▾</span>
      </button>
    );
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="pv">
          <span className="lbl">{label}</span> {currentLabel} <span className="car">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-pop" align="start" sideOffset={6}>
          {options.map((o) => (
            <DropdownMenu.Item
              key={o.key}
              className="menu-item"
              disabled={o.enabled === false}
              title={o.enabled === false ? o.title : undefined}
              onSelect={() => { if (o.enabled !== false) onSelect(o.key); }}
            >
              {o.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function PivotControls({ value, onChange }: PivotControlsProps): JSX.Element {
  return (
    <div className="pivot">
      <PvChip label="Metric" options={metricOptions()} current={value.metric}
        onSelect={(metric) => onChange({ ...value, metric })} />
      <span className="pv-sep">by</span>
      <PvChip label="Group" options={groupOptions()} current={value.group}
        onSelect={(group) => onChange({ ...value, group })} />
      <PvChip label="Subgroup" options={subgroupOptions()} current={value.subgroup}
        onSelect={(subgroup) => onChange({ ...value, subgroup })}
        disabled={value.rollup !== 'total'} disabledTitle="Not available with time rollups" />
      <PvChip label="Rollup" options={rollupOptions()} current={value.rollup}
        onSelect={(rollup) => onChange({ ...value, rollup })} />
      <PvChip label="Top" options={TOPN_OPTIONS} current={value.topN}
        onSelect={(topN) => onChange({ ...value, topN })} />
      <span className="pv add" title="More filters coming soon">+ Filter</span>
    </div>
  );
}
