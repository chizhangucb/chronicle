import type { JSX, ReactNode } from 'react';
import { Link } from 'wouter';
import { t } from '../i18n.js';

// The 5-domain status band (CHI-325 3d, decision D1/D2).
//
// A SECOND, DIFFERENT READ from the KPI strip above it, not a dedupe: the
// tiles state a number flat, the band adds the trend glyph, the explicit
// baseline NUMBER, and a deep link per domain. Spend and Sessions appear in
// both on purpose, because "how much" and "compared to what" are different
// questions.
//
// Rules carried over from Varde's design gate, because they are what make the
// band honest rather than decorative:
//
//  - THE BAND NEVER ORIGINATES AN ALARM. Its accent is an echo of an open
//    needs-you card above it, so the home has exactly one place that raises
//    something new.
//  - BASELINE NUMBER PLUS RATIO, never the ratio alone. "1.4x" without saying
//    1.4x of what is a number you cannot argue with.
//  - A row with NO DATA claims nothing. It does not invent an "ok".

export type BandTone = 'ok' | 'warn' | 'err' | 'neutral';

export interface BandRow {
  name: string;
  /** Deep link for the whole row. */
  to: string;
  /** Identity dot class suffix (band-dot-<domain>). */
  domain: string;
  /** Primary reading, usually today. */
  primary: ReactNode;
  /** One context reading: the baseline, the comparison, the second dimension. */
  context: ReactNode;
  /** Sparkline / count / next-run label. Optional per row. */
  glyph?: ReactNode;
  /** Echo of an open needs-you card on this domain. Never self-originated. */
  flagged?: boolean;
  /** Quiet right-hand state word. Omit it when the row cannot honestly claim
   *  one: the band renders a muted placeholder rather than an empty cell, so a
   *  "we cannot say" reads as deliberate instead of broken (Chi, 2026-08-28). */
  state?: ReactNode;
  tone?: BandTone;
}

export function StatusBand({ rows }: { rows: BandRow[] }): JSX.Element {
  return (
    <div className="card status-band">
      <h3>{t('Status')}</h3>
      {/* Column headers complete the schema. Honest names over pretty ones:
          "now" because Memory counts notes rather than a today reading, and
          "glance" because that column mixes a sparkline, a count and a clock. */}
      <div className="band-head">
        <span>{t('domain')}</span>
        <span>{t('now')}</span>
        <span className="band-ctx">{t('context')}</span>
        <span className="band-glance">{t('glance')}</span>
        <span className="band-state">{t('state')}</span>
      </div>
      {rows.map((row) => (
        <Link key={row.name} href={row.to} className={`band-row ${row.flagged ? 'flagged' : ''}`}>
          <span className="band-name">
            <span className={`band-dot band-dot-${row.domain}`} aria-hidden="true" />
            {t(row.name)}
          </span>
          <span className="band-primary">{row.primary}</span>
          <span className="band-ctx">{row.context}</span>
          <span className="band-glance">{row.glyph ?? null}</span>
          <span className={`band-state tone-${row.state == null ? 'unknown' : (row.tone ?? 'neutral')}`}>
            {row.state ?? '-'}
          </span>
        </Link>
      ))}
    </div>
  );
}

/**
 * A bare trend line. Deliberately not a chart: no axes, no tooltip, no library.
 * It answers "which way, roughly" at a glance and nothing else, which is the
 * only question a 90px-wide glyph can honestly answer.
 *
 * Replaces Varde's 3D graph thumbnail for the Memory row. That thumbnail is
 * what forced the entire node/link payload onto the default route; a growth
 * sparkline reads nearly as well for a fraction of the cost.
 */
export function Sparkline({ values, label }: { values: number[]; label?: string }): JSX.Element | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const span = max - min || 1;
  const w = 76, h = 16;
  const step = w / (clean.length - 1);
  const d = clean
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="band-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label ?? 'trend'}>
      <path d={d} fill="none" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One filled dot per open gap, one hollow per watch gap. Quiet chrome: the
 *  band reports the count, it does not raise the alarm. */
export function GapDots({ open, watch }: { open: number; watch: number }): JSX.Element | null {
  const total = open + watch;
  if (total === 0) return null;
  const shown = Math.min(total, 8);
  return (
    <span className="gap-dots" aria-label={`${open} open, ${watch} watch`}>
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className={`gap-dot ${i < open ? 'on' : ''}`} />
      ))}
    </span>
  );
}
