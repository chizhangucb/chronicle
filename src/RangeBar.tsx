import React from 'react';
import { t } from './i18n.js';

// The ONE time-range vocabulary for every range/window toggle in the app
// (D10, Task 17 — feedback-round). Before this, the home page at `/` rangebar
// (Today · 7d · 30d · 90d · All) and ProjectDetail's rangebar
// (Today · 7 Days · 30 Days · 1 Year · All time) had independently drifted
// option sets AND labels. This is now the single source of truth both
// mount — do not fork a local copy or add a 6th option / relabel an
// existing one without a matching `spec/surface-contract.md` edit +
// Chi's sign-off (see the D10 entry there).
export type RangeKey = 'today' | '7d' | '30d' | '90d' | 'all';

export interface RangeOption { key: RangeKey; label: string; }

export const RANGE_OPTIONS: RangeOption[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
];

// Shared "days" resolver: `daysToday` is fractional days since LOCAL
// midnight (each caller computes it the same way — see HomeDashboard's
// `daysToday`/ProjectDetail's `days` memo); `null` means no cutoff (All).
export function rangeDays(key: RangeKey, daysToday: number): number | null {
  switch (key) {
    case 'today': return daysToday;
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    case 'all': return null;
  }
}

// A stored/URL-sourced range key can go stale (e.g. an old "365"/"1 Year"
// value from before this unification) — degrade anything not in
// RANGE_OPTIONS to the default 'today' rather than rendering a dead toggle.
export function coerceRangeKey(value: string | null | undefined, fallback: RangeKey = 'today'): RangeKey {
  return RANGE_OPTIONS.some((o) => o.key === value) ? (value as RangeKey) : fallback;
}

export interface RangeBarProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function RangeBar({ value, onChange, className, style }: RangeBarProps): React.JSX.Element {
  return (
    <div className={`rangebar${className ? ` ${className}` : ''}`} style={style}
      role="tablist" aria-label={t('Time range')} title={t('Time range')}>
      {RANGE_OPTIONS.map((opt) => (
        <button key={opt.key} type="button" role="tab" aria-selected={value === opt.key}
          className={value === opt.key ? 'on' : ''} onClick={() => onChange(opt.key)}>
          {t(opt.label)}
        </button>
      ))}
    </div>
  );
}
