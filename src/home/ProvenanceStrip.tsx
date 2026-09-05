import { type JSX } from 'react';
import { type InsightsResult } from '../api.js';
import { useCostMode } from '../costMode.tsx';
import { t } from '../i18n.js';
import InfoTip from '../InfoTip.tsx';


/**
 * The provenance strip: the last row of the Overview tab.
 *
 * It answers "where did these numbers come from and how old are they" in one
 * line. The topbar's sync pill says when data last landed; it does not say
 * which SOURCES are behind the figures, which on a console that merges four
 * tools is the credibility question.
 */
export function ProvenanceStrip({ insights, syncText }: {
  insights: InsightsResult | null;
  syncText: string;
}): JSX.Element | null {
  const { mode } = useCostMode();
  if (!insights) return null;
  // Same derivation the Spend tab's Sources card uses, so the two can never
  // disagree about which tools are behind the numbers.
  const counts = new Map<string, number>();
  for (const s of insights.sessions) counts.set(s.source, (counts.get(s.source) ?? 0) + 1);
  const sources = [...counts.entries()].map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions);
  return (
    <div className="provenance-strip">
      <span className="prov-label">{t('sources')}</span>
      <span className="prov-items">
        {sources.length
          ? sources.map((s) => <span key={s.source} className="prov-item">{s.source} <b>{s.sessions}</b></span>)
          : <span className="muted">{t('no imported sessions')}</span>}
        <span className="prov-item">{syncText}</span>
        <span className="prov-item">{mode === 'real' ? t('billed') : t('list price')}</span>
        <InfoTip def="overview.provenance" />
      </span>
    </div>
  );
}
