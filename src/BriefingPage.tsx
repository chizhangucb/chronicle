import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, type BriefingResult, type ResolvedCardView, type CardActionView } from './api.js';
import { BriefingCard } from './cards/BriefingCards.tsx';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

// Briefing ops surface (CHI-323 3d): the daily action cards the briefing run
// produced, with terminal-outcome actions. Covers jobs / safety / coverage and
// spend (CHI-324 2i). Hidden from nav when the hub is absent.
type Filter = 'all' | 'needs' | 'fyi' | 'handled';

export default function BriefingPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [, navigate] = useLocation();
  const [data, setData] = useState<BriefingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function load() {
    try { setData(await api.briefing()); } catch (e) { setError(String((e as Error).message)); }
  }
  useEffect(() => { load(); }, []);

  async function act(id: string, action: CardActionView) {
    try {
      const res = await api.briefingAction(id, action);
      setData((prev) => (prev ? { ...prev, cards: res.cards, followThrough: res.followThrough } : prev));
    } catch (e) { setError(String((e as Error).message)); }
  }

  async function runNow() {
    setError(null);
    try {
      await api.briefingRun();
      setRunning(true);
      const poll = setInterval(async () => {
        const s = await api.briefingRunStatus().catch(() => null);
        if (s && !s.running) { clearInterval(poll); setRunning(false); load(); }
      }, 2000);
    } catch (e) { setError(String((e as Error).message)); setRunning(false); }
  }

  if (error && !data) return <div className="page center muted">{t('Could not load the briefing')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;

  const open = data.cards.filter((c) => c.state === 'open');
  const needsYou = open.filter((c) => c.needsYou);
  const fyi = open.filter((c) => !c.needsYou);
  const later = data.cards.filter((c) => c.state !== 'open');
  const ft = data.followThrough;
  const show = (f: Filter) => filter === 'all' || filter === f;

  return (
    <div className="page briefing-page">
      <div className="briefing-header">
        <div>
          <div className="eyebrow">{t('Briefing')}</div>
          <p className="muted small">
            {data.generatedAt ? `${t('As of')} ${formatRelativeTime(data.generatedAt)}` : t('No briefing has run yet.')}
            {' · '}{ft.open} {t('open')} · {ft.snoozed} {t('snoozed')}
          </p>
        </div>
        <button type="button" className="btn" onClick={runNow} disabled={running}>
          {running ? t('Running…') : t('Run now')}
        </button>
      </div>

      {/* Filter (Chi, 2026-08-28). The page previously rendered three fixed
          sections with no way to narrow: on a busy ledger the Handled section
          buries the two cards that actually want an answer. Counts live on the
          chips so the shape of the day is readable without switching. */}
      {data.cards.length > 0 && (
        <div className="tabs briefing-filter">
          {([
            ['all', t('All'), data.cards.length],
            ['needs', t('Needs you'), needsYou.length],
            ['fyi', t('Awareness'), fyi.length],
            ['handled', t('Handled'), later.length],
          ] as [Filter, string, number][]).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className={`tab ${filter === key ? 'on' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label} <span className="tab-count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="gate-error">{error}</p>}

      {data.cards.length === 0 ? (
        <div className="page center muted briefing-empty">{t('Nothing needs you. Run the briefing to generate today’s cards.')}</div>
      ) : (
        <>
          {show('needs') && <Section title={t('Needs you')} cards={needsYou} onAction={act} onOpenLink={navigate} />}
          {show('fyi') && <Section title={t('For your awareness')} cards={fyi} onAction={act} onOpenLink={navigate} />}
          {/* Handled is the HISTORY, so it is grouped by the day it was acted
              on rather than run together. briefing.json is a 90-day ledger
              (mergeRuns + LEDGER_KEEP_DAYS), and a flat list of it answered
              "what happened" but never "when". */}
          {show('handled') && <HandledSection cards={later} onAction={act} onOpenLink={navigate} />}
        </>
      )}
    </div>
  );
}

/** Handled cards, newest day first. `actedAt` is when the operator answered the
 *  card; a card with none (auto-resolved) falls back to its run day. */
function HandledSection({ cards, onAction, onOpenLink }: {
  cards: ResolvedCardView[];
  onAction: (id: string, a: CardActionView) => void; onOpenLink: (to: string) => void;
}) {
  if (!cards.length) return null;
  const byDay = new Map<string, ResolvedCardView[]>();
  for (const c of cards) {
    const stamp = c.actedAt ?? c.runAt;
    const day = stamp ? stamp.slice(0, 10) : 'unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(c);
  }
  const days = [...byDay.keys()].sort().reverse();
  return (
    <section className="briefing-section">
      <div className="eyebrow briefing-sec-head">{t('Handled')} · {cards.length}</div>
      {days.map((day) => (
        <div key={day} className="handled-day">
          <div className="handled-day-head">
            {day === 'unknown' ? t('undated') : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            <span className="muted"> · {byDay.get(day)!.length}</span>
          </div>
          {byDay.get(day)!.map((c) => <BriefingCard key={c.id} card={c} onAction={onAction} onOpenLink={onOpenLink} />)}
        </div>
      ))}
      <p className="muted small handled-note">
        {t('Handled cards stay here for 90 days after you act on them, then drop off.')}
      </p>
    </section>
  );
}

function Section({ title, cards, onAction, onOpenLink }: {
  title: string; cards: ResolvedCardView[];
  onAction: (id: string, a: CardActionView) => void; onOpenLink: (to: string) => void;
}) {
  if (!cards.length) return null;
  return (
    <section className="briefing-section">
      <div className="eyebrow briefing-sec-head">{title} · {cards.length}</div>
      {cards.map((c) => <BriefingCard key={c.id} card={c} onAction={onAction} onOpenLink={onOpenLink} />)}
    </section>
  );
}
