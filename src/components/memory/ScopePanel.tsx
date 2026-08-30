import { useEffect, useRef, useState } from 'react';
import Modal from '../../Modal.tsx';
import { api } from '../../api.js';
import { gateSubmit, type GateProposal, GateError } from '../../gate/gate.ts';
import { t } from '../../i18n.js';
import type { MemoryScopeEcho } from './types.ts';

// The Scope panel (CHI-339, the 1g fast-follow): how Memory's numbers are
// calculated, rendered FROM the resolved config so the copy can never drift
// from reality. Both the hand-edit and the AI-suggested mapping go through the
// standard gate confirm flow (gatePropose -> the page's GateConfirmDialog);
// nothing here writes directly. Chronicle-native port of Varde's ScopePanel.tsx.

const TIER_SENSE: Record<'living' | 'historical' | 'excluded', string> = {
  living: 'maintained-in-place knowledge; measured for usage, rot and growth',
  historical: 'dated records drawn as evidence; they never rot',
  excluded: 'not measured (and anything no pattern matches)',
};

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function DefinitionLine({ tier, label, patterns }: { tier: 'living' | 'historical' | 'excluded'; label: string; patterns: string[] | undefined }) {
  return (
    <p className="muted small scope-def-line">
      <span className="scope-def-label">{label}</span> = <span className="num">{patterns?.length ? patterns.join(', ') : t('nothing')}</span>
      <span className="scope-def-sense"> · {t(TIER_SENSE[tier])}</span>
    </p>
  );
}

export function ScopePanel({
  scope,
  onClose,
  onProposal,
  onError,
}: {
  scope: MemoryScopeEcho | undefined;
  onClose: () => void;
  /** A confirm card is ready; the page owns the single GateConfirmDialog. */
  onProposal: (p: GateProposal) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [living, setLiving] = useState('');
  const [historical, setHistorical] = useState('');
  const [excluded, setExcluded] = useState('');
  const [rotDays, setRotDays] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = (): void => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setSuggesting(false);
  };
  useEffect(() => stopPolling, []);

  const tiers = scope?.tiers;

  const fail = (err: unknown): void => {
    onError(err instanceof GateError && err.fix ? `${err.message} — ${err.fix}` : String((err as Error).message));
  };

  const beginEdit = (): void => {
    setLiving((tiers?.living ?? []).join('\n'));
    setHistorical((tiers?.historical ?? []).join('\n'));
    setExcluded((tiers?.excluded ?? []).join('\n'));
    setRotDays(String(scope?.rotDays ?? 30));
    setEditing(true);
    setNotice(null);
  };

  const proposeEdit = async (): Promise<void> => {
    try {
      const change: Record<string, unknown> = {
        scope: { living: splitLines(living), historical: splitLines(historical), excluded: splitLines(excluded) },
      };
      const days = Number(rotDays);
      if (Number.isFinite(days) && days > 0) change.rotDays = days;
      // A hand edit is the operator typing their own scope: it applies without
      // a card (CHI-329). The panel says so rather than silently closing.
      const out = await gateSubmit('memory-scope', change, 'Edit the memory scope from the Scope panel');
      if (out.applied) setNotice(t('Scope updated. It takes effect on the next memory read.'));
      else onProposal(out.proposal);
      setEditing(false);
    } catch (err) {
      fail(err);
    }
  };

  const suggest = async (): Promise<void> => {
    setNotice(null);
    try {
      await api.scopeSuggestStart();
      setSuggesting(true);
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.scopeSuggestStatus();
          if (status.running) return;
          stopPolling();
          if (status.suggestion) {
            // The proposal card IS the review step: current vs. proposed
            // mapping, confirm or deny. Marked `suggestion` so the server cards
            // it even though the surface is otherwise auto (CHI-329 floor 1b) —
            // model output is never written unreviewed.
            const out = await gateSubmit('memory-scope', { scope: status.suggestion }, "AI-suggested scope mapping (from the hub's folder names; review the diff)", 'suggestion');
            if (!out.applied) onProposal(out.proposal);
          } else {
            onError(status.error ?? t('suggest run produced nothing'));
          }
        } catch (err) {
          stopPolling();
          fail(err);
        }
      }, 2000);
    } catch (err) {
      fail(err);
    }
  };

  const dirs = scope?.dirs ?? [];

  return (
    <Modal onClose={onClose} title={t('Measurement scope')} className="scope-panel-modal">
      <div className="modal-head"><h3>{t('Measurement scope')}</h3></div>
      <p className="muted small scope-lede">
        {t('What Memory counts, straight from')} {scope?.source === 'config' ? t('your memory-scope config') : t('the shipped defaults')}. {t('Edits apply through a confirm card and take effect on the next memory read.')}
      </p>

      <div className="scope-definitions">
        <DefinitionLine tier="living" label={t('Living')} patterns={tiers?.living} />
        <DefinitionLine tier="historical" label={t('Records')} patterns={tiers?.historical} />
        <DefinitionLine tier="excluded" label={t('Excluded')} patterns={tiers?.excluded} />
        <p className="muted small">
          {t('Rot threshold')}: <span className="num">{scope?.rotDays ?? 30}</span> {t('days')}
          {Object.keys(scope?.rotDaysByKind ?? {}).length
            ? ` · ${t('per-kind overrides')}: ${Object.entries(scope?.rotDaysByKind ?? {}).map(([k, v]) => `${k} ${v}d`).join(', ')}`
            : ` · ${t('flat, all kinds')}`}
        </p>
      </div>

      {dirs.length ? (
        <table className="jobs-table scope-dirs-table">
          <thead><tr><th>{t('Folder')}</th><th>{t('Tier')}</th><th>{t('Notes')}</th></tr></thead>
          <tbody>
            {dirs.map((d) => (
              <tr key={`${d.dir}-${d.tier}`}>
                <td className="num">{d.dir}</td>
                <td className="muted">{d.tier === 'historical' ? t('records') : d.tier}</td>
                <td className="num">{d.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">{t('No measured folders found on this machine yet. Edit the scope to point Memory at your knowledge base.')}</p>
      )}

      {editing ? (
        <div className="scope-edit-fields">
          {([
            [t('Living'), living, setLiving],
            [t('Records'), historical, setHistorical],
            [t('Excluded'), excluded, setExcluded],
          ] as const).map(([label, value, set]) => (
            <label key={label} className="scope-edit-field">
              <span className="muted small">{label} · {t('one pattern per line')}</span>
              <textarea className="json-textarea scope-textarea" value={value} spellCheck={false} rows={3} onChange={(e) => set(e.target.value)} />
            </label>
          ))}
          <label className="scope-rot-field">
            <span className="muted small">{t('Rot threshold (days)')}</span>
            <input className="gate-code-input" value={rotDays} inputMode="numeric" onChange={(e) => setRotDays(e.target.value)} />
          </label>
          <div className="scope-actions">
            <button type="button" className="btn primary" onClick={() => void proposeEdit()}>{t('Propose change')}</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          </div>
        </div>
      ) : (
        <div className="scope-actions">
          <button type="button" className="btn" onClick={beginEdit}>{t('Edit scope')}</button>
          <button type="button" className="btn" disabled={suggesting} onClick={() => void suggest()}>
            {suggesting ? t('Asking your AI…') : t('Suggest scope')}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>{t('Close')}</button>
        </div>
      )}
      {notice && <p className="muted small">{notice}</p>}
    </Modal>
  );
}
