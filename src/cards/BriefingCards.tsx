import { useState } from 'react';
import type { ResolvedCardView, CardActionView } from '../api.js';
import { t } from '../i18n.js';

// One briefing card (CHI-323 3d). Plain-language anatomy up top, technical
// evidence behind an expander, terminal-outcome actions at the foot. A card
// either needs you or it does not (binary, no severity ladder).
export function BriefingCard({ card, onAction, onOpenLink }: {
  card: ResolvedCardView;
  onAction: (id: string, action: CardActionView) => void;
  onOpenLink: (to: string) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const acted = card.state === 'done' || card.state === 'dismissed' || card.state === 'resolved';
  return (
    <div className={`briefing-card ${card.needsYou && card.state === 'open' ? 'needs-you' : ''} ${acted ? 'acted' : ''}`}>
      <div className="bc-head">
        <span className={`bc-domain ${card.domain}`}>{card.domain}</span>
        <span className="bc-title">{card.title}</span>
        {card.state !== 'open' && <span className={`bc-state ${card.state}`}>{card.state}</span>}
      </div>
      <p className="bc-summary">{card.summary}</p>
      {(card.whatHappened || card.whatItMeans || card.whatToDo) && (
        <div className="bc-anatomy">
          {card.whatHappened && <div><span className="bc-label">{t('What happened')}</span> {card.whatHappened}</div>}
          {card.whatItMeans && <div><span className="bc-label">{t('What it means')}</span> {card.whatItMeans}</div>}
          {card.whatToDo && <div><span className="bc-label">{t('What to do')}</span> {card.whatToDo}</div>}
        </div>
      )}
      {card.evidence && (
        <div className="bc-evidence">
          <button type="button" className="btn tiny ghost" onClick={() => setShowEvidence((s) => !s)}>
            {showEvidence ? t('Hide evidence') : t('Evidence')}
          </button>
          {showEvidence && <pre className="bc-evidence-body">{card.evidence}</pre>}
        </div>
      )}
      <div className="bc-actions">
        {card.link && <button type="button" className="btn tiny" onClick={() => onOpenLink(card.link!.to)}>{card.link.label}</button>}
        <span className="bc-spacer" />
        {card.state === 'open' && <>
          <button type="button" className="btn tiny" onClick={() => onAction(card.id, 'done')}>{t('Done')}</button>
          <button type="button" className="btn tiny" onClick={() => onAction(card.id, 'snooze')}>{t('Snooze')}</button>
          <button type="button" className="btn tiny ghost" onClick={() => onAction(card.id, 'dismiss')}>{t('Dismiss')}</button>
        </>}
        {(acted || card.state === 'snoozed') && (
          <button type="button" className="btn tiny ghost" onClick={() => onAction(card.id, 'reopen')}>{t('Reopen')}</button>
        )}
      </div>
    </div>
  );
}
