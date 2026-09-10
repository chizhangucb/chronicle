import React, { useState, type JSX, type ReactNode } from 'react';
import { KIND_ICON, KIND_LABEL } from '../kinds.ts';
import { summarizeToolInput } from './stats.js';
import type { DisplayKind, Event } from '@shared/types.ts';

// A rendered playback row. `seq`/`kind` are always present on a fetched/live
// message; `live` is stamped by SessionView on rows arriving over live SSE.
export interface PlaybackMessage extends Event {
  seq: number;
  live?: boolean;
}

export interface MessageRowProps {
  m: PlaybackMessage;
  selected: boolean;
  keyword: string;
  onClick: () => void;
}

// Labels/icons come from the shared canonical map (src/kinds.ts) so Playback and
// Refine stay consistent; only the per-view CSS class lives here.
const KIND_CLS: Record<DisplayKind, string> = {
  user: 'user', assistant: 'assistant', thinking: 'thinking', tool_use: 'tool', tool_result: 'tool-result', note: 'note',
};
interface KindMeta { icon: string; label: string; cls: string; }
const KIND_META: Record<string, KindMeta> = Object.fromEntries(
  (Object.keys(KIND_CLS) as DisplayKind[]).map((k) => [k, { icon: KIND_ICON[k], label: KIND_LABEL[k], cls: KIND_CLS[k] }]),
);

export default function MessageRow({ m, selected, keyword, onClick }: MessageRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const meta: KindMeta = KIND_META[m.kind] || { icon: '•', label: m.kind, cls: '' };
  let body = m.text || '';
  let title: string | null = null;
  if (m.kind === 'tool_use') {
    title = m.tool_name ?? null;
    body = summarizeToolInput(m.tool_name, m.tool_input);
  }
  const limit = m.kind === 'user' || m.kind === 'assistant' ? 1200 : 300;
  const isLong = body.length > limit;
  const shown = expanded || !isLong ? body : body.slice(0, limit) + '…';

  return (
    <div data-seq={m.seq} className={`msg ${meta.cls} ${selected ? 'selected' : ''} ${m.live ? 'fade-in' : ''}`} onClick={onClick}>
      <div className="msg-head">
        <span className="msg-kind">{meta.icon} {title || meta.label}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {m.ts && <span className="msg-ts muted">{new Date(m.ts).toLocaleTimeString()}</span>}
        </span>
      </div>
      <div className={`msg-body ${expanded ? 'expanded' : ''}`}>{highlight(shown, keyword)}</div>
      {isLong && (
        <button className="btn ghost tiny msg-expand" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
          {expanded ? 'Show less' : `Show all (${body.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function highlight(text: string, keyword: string): ReactNode {
  if (!keyword) return text;
  const parts: ReactNode[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  let idx: number;
  while ((idx = lower.indexOf(keyword, i)) !== -1 && parts.length < 200) {
    parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + keyword.length)}</mark>);
    i = idx + keyword.length;
  }
  parts.push(text.slice(i));
  return parts;
}
