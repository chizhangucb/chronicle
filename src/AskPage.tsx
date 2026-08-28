import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AskTurn, type AskCostMode } from './api.js';
import { useCostMode } from './costMode.js';
import { t } from './i18n.js';
import InfoTip from './InfoTip.js';

// /ask (CHI-351): one conversation column answered from chronicle.db via the
// local claude runner. Day dividers, durable history, prose + full-width table +
// SQL expander + cost-basis label per answer. Judged against the approved D3 mock.

const basisOf = (mode: string): AskCostMode => (mode === 'real' ? 'billed' : 'list');
const basisLabel = (b: AskCostMode): string => (b === 'billed' ? t('Billed') : t('List price'));
const dayKey = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toDateString(); };
const dayLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function AskPage(): React.JSX.Element {
  const { mode } = useCostMode();
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [pending, setPending] = useState<string | null>(null); // the in-flight question
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const convoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.askHistory().then((h) => setTurns(h.turns)).catch(() => setTurns([]));
  }, []);

  // Autofocus on mount and whenever App routes here via Cmd-J.
  useEffect(() => {
    inputRef.current?.focus();
    const onFocus = (): void => inputRef.current?.focus();
    window.addEventListener('ask:focus', onFocus);
    return () => window.removeEventListener('ask:focus', onFocus);
  }, []);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pending]);

  const ask = useCallback(async (question: string, costMode: AskCostMode) => {
    const q = question.trim();
    if (!q || pending) return;
    setPending(q);
    setError(null);
    try {
      const { turn } = await api.postAsk(q, costMode);
      setTurns((prev) => [...prev, turn]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.replace(/^\d+\s*/, '') || t('The query run failed'));
    } finally {
      setPending(null);
    }
  }, [pending]);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const el = inputRef.current;
    if (!el) return;
    const q = el.value;
    el.value = '';
    void ask(q, basisOf(mode));
  };

  // Group consecutive turns under a day divider.
  const groups: { day: string; iso: string; turns: AskTurn[] }[] = [];
  for (const turn of turns) {
    const k = dayKey(turn.ts);
    const last = groups[groups.length - 1];
    if (last && last.day === k) last.turns.push(turn);
    else groups.push({ day: k, iso: turn.ts, turns: [turn] });
  }

  return (
    <div className="page ask-page">
      <div className="eyebrow">{t('Ask')}</div>
      <div className="ask-sub muted">
        {t('Ask anything about your sessions, spend, and models — answered from chronicle.db, locally')}
        <InfoTip def="ask.local" />
      </div>

      <div className="ask-convo" ref={convoRef}>
        {turns.length === 0 && !pending && (
          <div className="ask-empty muted">
            <div className="ask-empty-mark">∴</div>
            <p>{t('Ask a question about your sessions, spend, or models. Answers come straight from your local database.')}</p>
            <ul className="ask-examples">
              <li>{t('which mcp server cost most this week?')}</li>
              <li>{t('how much did subagents cost me last month?')}</li>
              <li>{t('which projects have the most error-heavy sessions?')}</li>
            </ul>
          </div>
        )}

        {groups.map((g) => (
          <React.Fragment key={g.day + g.turns[0].id}>
            <div className="ask-day"><span className="eyebrow">{dayLabel(g.iso)}</span></div>
            {g.turns.map((turn) => (
              <React.Fragment key={turn.id}>
                <div className="ask-q">{turn.question}</div>
                <AskAnswer turn={turn} onReask={(b) => ask(turn.question, b)} disabled={!!pending} />
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}

        {pending && (
          <>
            <div className="ask-q">{pending}</div>
            <div className="ask-answer ask-thinking">
              <span className="ask-dots"><i /><i /><i /></span>
              {t('Querying chronicle.db…')}
            </div>
          </>
        )}
        {error && <div className="ask-answer ask-answer-err">{error}</div>}
      </div>

      <form className="ask-input" onSubmit={onSubmit}>
        <span className="ask-input-glyph" aria-hidden>?</span>
        <input ref={inputRef} type="text" className="ask-input-field" maxLength={2000}
          placeholder={t('Ask about your sessions, spend, models…')}
          aria-label={t('Ask a question')} disabled={!!pending} />
        <button type="submit" className="ask-send" disabled={!!pending} aria-label={t('Send')}>↵</button>
        <span className="ask-kbd" aria-hidden>⌘J</span>
      </form>
      <div className="ask-foot muted">
        {t('runs locally via your claude CLI · read-only SQL over chronicle.db · history stays in ~/.chronicle · nothing leaves your machine')}
      </div>
    </div>
  );
}

function AskAnswer({ turn, onReask, disabled }: { turn: AskTurn; onReask: (b: AskCostMode) => void; disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const other: AskCostMode = turn.costBasis === 'billed' ? 'list' : 'billed';
  if (!turn.ok) {
    return <div className="ask-answer ask-answer-err">{turn.prose || turn.error || t('Could not answer that one.')}</div>;
  }
  const hasTable = turn.columns.length > 0 && turn.rows.length > 0;
  return (
    <div className="ask-answer">
      <div className="ask-prose">{turn.prose}</div>
      {turn.note && <div className="ask-note muted">{turn.note}</div>}
      {hasTable && (
        <div className="ask-tbl-wrap">
          <table className="ask-tbl">
            <thead><tr>{turn.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {turn.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}>{formatCell(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {turn.truncated && <div className="ask-tbl-more muted">{t('showing the first rows')} ({turn.rowCount})</div>}
        </div>
      )}
      <div className="ask-answer-foot">
        {turn.sql
          ? <button type="button" className="ask-sql-toggle" onClick={() => setOpen((o) => !o)}>SQL {open ? '▾' : '▸'}</button>
          : <span className="ask-sql-toggle disabled">{t('no query')}</span>}
        <span className="ask-basis muted">
          {basisLabel(turn.costBasis)}
          {' · '}
          <button type="button" className="ask-reask" disabled={disabled} onClick={() => onReask(other)}>
            {t('re-ask under')} {basisLabel(other)}
          </button>
        </span>
      </div>
      {open && turn.sql && <pre className="ask-sql">{turn.sql}</pre>}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : String(v);
  return String(v);
}
