import React, { type JSX } from 'react';
import MessageRow, { type PlaybackMessage } from './MessageRow.tsx';
import type { CausalityData } from '../SessionView.tsx';

// FR-COMPAT-2: degrade gracefully on huge sessions — render a window of
// messages around the selection instead of the full list. Shared by the
// playback pane and the subagent drill-in pane (both render a `.conv-pane`
// list with the same windowing math).
const WINDOW = 400;

export interface WindowedConvPaneProps {
  messages: PlaybackMessage[];
  selectedSeq: number | null;
  keyword?: string;
  causality?: CausalityData | null;
  onSelect: (seq: number, scroll?: boolean) => void;
  className?: string;
  paneRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  header?: React.ReactNode;
  emptyText: string;
}

export default function WindowedConvPane({
  messages, selectedSeq, keyword = '', causality, onSelect, className = '', paneRef, onScroll, header, emptyText,
}: WindowedConvPaneProps): JSX.Element {
  const selIdx = Math.max(0, messages.findIndex((m) => m.seq === selectedSeq));
  const winStart = messages.length > WINDOW ? Math.max(0, Math.min(selIdx - WINDOW / 2, messages.length - WINDOW)) : 0;
  const winEnd = Math.min(messages.length, winStart + WINDOW);
  const windowed = messages.slice(winStart, winEnd);

  return (
    <div className={className ? `conv-pane ${className}` : 'conv-pane'} ref={paneRef} onScroll={onScroll}>
      {header}
      {winStart > 0 && (
        <button className="btn small window-btn" onClick={() => onSelect(messages[Math.max(0, winStart - WINDOW / 2)].seq, true)}>
          ↑ {winStart.toLocaleString()} earlier messages
        </button>
      )}
      {windowed.map((m) => (
        <MessageRow key={m.seq} m={m} selected={m.seq === selectedSeq}
          keyword={keyword} onClick={() => onSelect(m.seq)}
          causality={causality?.changes.find((c) => c.seq === m.seq)}
          onJump={(seq) => onSelect(seq, true)} />
      ))}
      {winEnd < messages.length && (
        <button className="btn small window-btn" onClick={() => onSelect(messages[Math.min(messages.length - 1, winEnd + WINDOW / 2 - 1)].seq, true)}>
          ↓ {(messages.length - winEnd).toLocaleString()} later messages
        </button>
      )}
      {!messages.length && <div className="muted center pad8">{emptyText}</div>}
    </div>
  );
}
