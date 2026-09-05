import { useEffect, useState, type JSX } from 'react';
import { Link } from 'wouter';
import {
  api,
  type ActivityResult, type InsightsResult, type ResolvedCardView,
  type BriefingResult, type JobsSliceView, type SafetyGapsView,
  type CardActionView,
} from '../api.js';
import { StatusBand, Sparkline, GapDots, type BandRow } from './StatusBand.tsx';
import { buildCostedDays, windowAnomaly } from '../insights/anomalyMath.ts';
import { useCostMode } from '../costMode.tsx';
import { t } from '../i18n.js';
import InfoTip from '../InfoTip.tsx';

// The two new bands on / (CHI-325 3d, decisions D1/D2/D11).
//
// Order on the surface: briefing cards, then the KPI strip (unchanged), then
// this band, then the existing Activity / Anomaly / charts, then the
// provenance strip. The briefing goes ABOVE the numbers because it is the only
// part of the home that asks something of you; everything below it is a read.
//
// BOTH BANDS ARE OPT-OUT (D2). The Settings toggle collapses / back to exactly
// the Overview that shipped before this change, which is the escape hatch for
// "I just want the numbers".

function money(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}
function ratioText(r: number | null): string {
  return r == null ? '-' : `${r.toFixed(1)}x`;
}

/** Domains with an open needs-you card. The band's accent is an ECHO of these,
 *  so the band and the briefing above it can never point at different things. */
function flaggedDomains(cards: ResolvedCardView[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards) if (c.state === 'open' && c.needsYou) out.add(String(c.domain));
  return out;
}

/** Cards from the LATEST run only. Older runs live on /briefing; the home stays
 *  one viewport on a calm day. */
function latestRunCards(cards: ResolvedCardView[]): ResolvedCardView[] {
  if (!cards.length) return [];
  const newest = cards.reduce((a, c) => (c.runAt > a ? c.runAt : a), cards[0].runAt);
  return cards.filter((c) => c.runAt === newest);
}

export function BriefingBand({ briefing, onChanged }: {
  briefing: BriefingResult | null;
  onChanged: () => void;
}): JSX.Element | null {
  if (!briefing?.generatedAt) return null;
  const open = latestRunCards(briefing.cards).filter((c) => c.state === 'open');
  const needsYou = open.filter((c) => c.needsYou);
  const fyi = open.filter((c) => !c.needsYou);

  // A calm day is a RESULT, not an empty state: saying so is the answer to
  // "what needs my eyes today".
  if (!open.length) {
    return (
      <div className="card home-briefing calm">
        <span className="calm-mark" aria-hidden="true">◷</span>
        <span>{t('Nothing needs you right now.')}</span>
        <Link href="/briefing" className="calm-link">{t('briefing')} →</Link>
      </div>
    );
  }

  const act = async (id: string, action: CardActionView) => {
    await api.briefingAction(id, action).catch(() => {});
    onChanged();
  };

  return (
    <div className="home-briefing">
      {/* EVERY needs-you card is one line (Chi, 2026-08-28 review). The first
          draft gave the lead card the full what-happened/what-it-means/
          what-to-do anatomy, which ate most of the first viewport and pushed
          the numbers below the fold. The home's job is to say WHAT needs you;
          the full anatomy is one click away on /briefing. */}
      {needsYou.map((card) => (
        <div className="card compact-needs" key={card.id}>
          <span className={`band-dot band-dot-${card.domain}`} aria-hidden="true" />
          <Link href="/briefing" className="cn-title">{card.title}</Link>
          <span className="muted small cn-summary">{card.summary}</span>
          <button type="button" className="btn ghost small" onClick={() => act(card.id, 'done')}>{t('Done')}</button>
          <button type="button" className="btn ghost small" onClick={() => act(card.id, 'dismiss')}>{t('Dismiss')}</button>
        </div>
      ))}
      {fyi.length > 0 && (
        <div className="card home-fyi">
          {fyi.map((c) => (
            <div className="fyi-row" key={c.id}>
              <span className={`band-dot band-dot-${c.domain}`} aria-hidden="true" />
              <span className="fyi-title">{c.title}</span>
              <span className="muted small">{c.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HomeStatusBand({ insights, activity, briefing, hubPresent, days }: {
  insights: InsightsResult | null;
  activity: ActivityResult | null;
  briefing: BriefingResult | null;
  hubPresent: boolean;
  days: number | null;
}): JSX.Element | null {
  const { mode } = useCostMode();
  const [jobs, setJobs] = useState<JobsSliceView | null>(null);
  const [gaps, setGaps] = useState<SafetyGapsView | null>(null);

  useEffect(() => {
    if (!hubPresent) return;
    api.hubJobs().then((j) => setJobs('hubPresent' in j ? null : j)).catch(() => setJobs(null));
    api.hubSafety().then((s2) => setGaps('hubPresent' in s2 ? null : s2.gaps)).catch(() => setGaps(null));
  }, [hubPresent]);

  if (!activity?.burn || !insights) return null;

  const flagged = flaggedDomains(briefing?.cards ?? []);
  const anomaly = windowAnomaly(activity.burn, mode, days);
  const costed = buildCostedDays(activity.burn, mode);
  const spendSeries = costed.slice(-14).map((d) => d.cost);

  // Sessions-per-day is derived from insights.sessions, the SAME list the KPI
  // strip counts, so the band and the tile above it cannot disagree.
  //
  // NOT insights.dailyActivity: that counts MESSAGES, not sessions, and is
  // deliberately exempt from the window filter (it feeds the fixed 182-day
  // Working Rhythm heatmap). Using it here put "118 today" directly under a KPI
  // reading 40 sessions, which is the exact two-numbers-one-console failure this
  // merge exists to remove.
  const sessionsByDay = new Map<string, number>();
  for (const sess of insights.sessions) {
    if (!sess.started_at) continue;
    const d = new Date(sess.started_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    sessionsByDay.set(day, (sessionsByDay.get(day) ?? 0) + 1);
  }
  const sessionDays = [...sessionsByDay.keys()].sort();
  const sessionSeries = sessionDays.slice(-14).map((d) => sessionsByDay.get(d) ?? 0);
  const todaySessions = sessionsByDay.get(activity.burn.today) ?? 0;
  // Median of the trailing active days, the same shape of baseline the spend
  // row quotes (a typical day, not a mean that one spike can move).
  const priorSessions = sessionSeries.slice(0, -1).filter((n) => n > 0).sort((a, b) => a - b);
  const sessionBaseline = priorSessions.length ? priorSessions[Math.floor(priorSessions.length / 2)] : null;

  const rows: BandRow[] = [
    {
      name: 'Spend', to: '/?tab=spend', domain: 'spend',
      primary: <><b>{money(anomaly.current)}</b> {t('in window')}</>,
      // Baseline NUMBER plus ratio, never the ratio alone.
      context: anomaly.hasBaseline
        ? <>{t('baseline')} <b>{money(anomaly.baseline)}</b> · <b>{ratioText(anomaly.ratio)}</b></>
        : <>{t('no baseline yet')}</>,
      glyph: <Sparkline values={spendSeries} label={t('spend trend')} />,
      flagged: flagged.has('spend'),
      state: anomaly.hot ? t('above baseline') : anomaly.hasBaseline ? t('ok') : undefined,
      tone: anomaly.hot ? 'warn' : 'ok',
    },
    {
      name: 'Sessions', to: '/?tab=sessions', domain: 'sessions',
      primary: <><b>{todaySessions}</b> {t('today')}</>,
      context: sessionBaseline != null
        ? <>{t('baseline')} <b>~{sessionBaseline}/{t('day')}</b></>
        : <>{t('no baseline yet')}</>,
      glyph: <Sparkline values={sessionSeries} label={t('sessions trend')} />,
      flagged: flagged.has('sessions'),
      // "active" only ever describes literal today; a quiet day is quiet, not broken.
      state: todaySessions > 0 ? t('active') : t('quiet'),
      tone: todaySessions > 0 ? 'ok' : 'neutral',
    },
    safetyRow(gaps, hubPresent, flagged.has('safety')),
    jobsRow(jobs, hubPresent, flagged.has('jobs')),
  ];

  return <StatusBand rows={rows} />;
}

/** The Nisse upsell (D2). The three hub-fed rows still RENDER with no hub, and
 *  say plainly what would light them up. Chronicle's ops surfaces are real
 *  features that happen to need a hub, and hiding them entirely told a public
 *  user nothing about what the product can do. */
function upsell(name: string, domain: string, to: string): BandRow {
  return {
    name, to, domain,
    primary: <span className="muted">{t('not connected')}</span>,
    context: <span className="muted">{t('install Nisse to light this up')}</span>,
    state: undefined, tone: 'neutral',
  };
}

function safetyRow(gaps: SafetyGapsView | null, hubPresent: boolean, flagged: boolean): BandRow {
  if (!hubPresent) return upsell('Safety', 'safety', '/safety');
  const open = gaps?.actionable?.length ?? 0;
  const watch = gaps?.watch?.length ?? 0;
  return {
    name: 'Safety', to: '/safety', domain: 'safety',
    primary: <><b>{open}</b> {open === 1 ? t('open gap') : t('open gaps')}</>,
    context: <><b>{watch}</b> {t('watch')}</>,
    glyph: <GapDots open={open} watch={watch} />,
    flagged,
    state: gaps ? (open > 0 ? t('needs work') : t('ok')) : undefined,
    tone: open > 0 ? 'warn' : 'ok',
  };
}

function jobsRow(jobs: JobsSliceView | null, hubPresent: boolean, flagged: boolean): BandRow {
  if (!hubPresent) return upsell('Jobs', 'jobs', '/jobs');
  const all = jobs?.jobs ?? [];
  const scheduled = all.length;
  const failing = all.filter((j) => j.status === 'failed').length;
  // JobStatus has no 'due': the overdue-ish states are 'stale' (ran, but not
  // recently enough) and 'pending' (scheduled, never recorded a run). Grouping
  // them is what the Jobs page itself calls "needs a look".
  const due = all.filter((j) => j.status === 'stale' || j.status === 'pending').length;
  const healthy = all.filter((j) => j.status === 'success' || j.status === 'running').length;
  return {
    name: 'Jobs', to: '/jobs', domain: 'jobs',
    primary: <><b>{scheduled}</b> {t('scheduled')}</>,
    context: <><b>{healthy}</b> {t('ran ok')}</>,
    flagged,
    state: jobs ? (failing > 0 ? `${failing} ${t('failing')}` : due > 0 ? `${due} ${t('due')}` : t('ok')) : undefined,
    tone: failing > 0 ? 'err' : due > 0 ? 'warn' : 'ok',
  };
}

/**
 * The provenance strip (D11), a slimmed port of Varde's SourceFooter.
 *
 * It answers "where did these numbers come from and how old are they" in one
 * line. The topbar's sync pill says when data last landed; it does not say
 * which SOURCES are behind the figures, and on a console that merges four
 * tools plus a hub plus a proxy lane, that is the credibility question.
 */
export function ProvenanceStrip({ insights, hubPresent, syncText }: {
  insights: InsightsResult | null;
  hubPresent: boolean;
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
        <span className="prov-item">{t('hub')} {hubPresent ? t('connected') : t('absent')}</span>
        <span className="prov-item">{syncText}</span>
        <span className="prov-item">{mode === 'real' ? t('billed') : t('list price')}</span>
        <InfoTip def="overview.provenance" />
      </span>
    </div>
  );
}
