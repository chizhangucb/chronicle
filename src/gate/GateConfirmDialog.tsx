import { useEffect, useState } from 'react';
import Modal from '../Modal.tsx';
import { gateConfirm, type GateProposal } from './gate.ts';
import { t } from '../i18n.js';

// The confirm card for gate proposals (CHI-323): exactly what will change, shown
// as the validated diff, with Confirm or Deny as the only ways out. Closing the
// dialog denies; a card left alone dies on the server's 15-min TTL. Tier-2
// surfaces add a code field (the server texted a one-time code to the second
// channel; confirm needs it). Chronicle-native rewrite of Varde's Tailwind
// dialog, using the shared Modal + design-token CSS.
export function GateConfirmDialog({
  proposal,
  onSettled,
  destructive = false,
  plainSentence,
}: {
  proposal: GateProposal | null;
  /** true after a confirmed write, false on deny or error. */
  onSettled: (confirmed: boolean) => void;
  /** Destructive-action confirm (kill switch) gets the danger accent. */
  destructive?: boolean;
  /** One human sentence for what the change means; the diff stays below it. */
  plainSentence?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => { setCode(''); setError(null); }, [proposal?.id]);

  if (!proposal) return null;

  const decide = async (decision: 'confirm' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await gateConfirm(proposal.id, decision, code.trim() || undefined);
      onSettled(decision === 'confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A failed confirm keeps the card open (the proposal survives a wrong code
      // server-side). Deny always settles.
      if (decision === 'deny') onSettled(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => { if (!busy) decide('deny'); }} title={t('Confirm this change')} className="gate-dialog">
      <div className="modal-head"><h3>{t('Confirm this change')}</h3></div>
      <p className={plainSentence ? 'gate-lead' : 'muted small gate-lead'}>{plainSentence ?? proposal.reason}</p>
      {proposal.cardReason && (
        <p className="muted small gate-why">{t('Why you are seeing this')}: {proposal.cardReason}</p>
      )}
      {plainSentence && <div className="eyebrow gate-tech-label">{t('technical change')}</div>}
      <div className="gate-diff">
        {proposal.diff.map((e) => (
          <div key={e.path} className="gate-diff-row">
            <span className="gate-diff-path">{e.path}</span>
            <span className="gate-diff-from">{JSON.stringify(e.from) ?? 'unset'}</span>
            <span className="gate-diff-arrow">→</span>
            <span className="gate-diff-to">{JSON.stringify(e.to) ?? 'unset'}</span>
          </div>
        ))}
      </div>
      {proposal.requiresCode && (
        <div className="gate-code-row">
          <label htmlFor="gate-code" className="muted small">{t('Code from the Telegram card')}</label>
          <input id="gate-code" className="gate-code-input" value={code} inputMode="numeric" autoComplete="one-time-code"
            onChange={(e) => setCode(e.target.value)} />
        </div>
      )}
      {error && <p className="gate-error">{error}</p>}
      <div className="gate-actions">
        <button type="button" className={`btn ${destructive ? 'danger' : 'primary'}`}
          disabled={busy || (proposal.requiresCode && !code.trim())} onClick={() => decide('confirm')}>
          {t('Confirm')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => decide('deny')}>{t('Deny')}</button>
        <span className="muted small gate-expiry">{t('expires in 15 min')}</span>
      </div>
    </Modal>
  );
}
