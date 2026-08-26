import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, type BriefingResult, type ResolvedCardView, type CardActionView } from './api.js';
import { BriefingCard } from './cards/BriefingCards.tsx';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

// Briefing ops surface (CHI-323 3d): the daily action cards the briefing run
// produced, with terminal-outcome actions. Non-spend cards this phase (D7); the
// spend cards land in phase 2. Hidden from nav when the hub is absent.
export default function BriefingPage() {
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
      {error && <p className="gate-error">{error}</p>}
      <p className="muted small briefing-scope">{t('Phase 1 covers jobs, safety and coverage. Spend cards arrive with the spend detector.')}</p>

      {data.cards.length === 0 ? (
        <div className="page center muted briefing-empty">{t('Nothing needs you. Run the briefing to generate today’s cards.')}</div>
      ) : (
        <>
          <Section title={t('Needs you')} cards={needsYou} onAction={act} onOpenLink={navigate} />
          <Section title={t('For your awareness')} cards={fyi} onAction={act} onOpenLink={navigate} />
          <Section title={t('Handled')} cards={later} onAction={act} onOpenLink={navigate} />
        </>
      )}
    </div>
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
