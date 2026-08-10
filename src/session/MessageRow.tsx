import React, { useState, type JSX, type ReactNode } from 'react';
import { t } from '../i18n.js';
import { KIND_ICON, KIND_LABEL } from '../kinds.ts';
import { summarizeToolInput } from './stats.js';
import type { DisplayKind, Event } from '@shared/types.ts';

// A rendered playback row. `seq`/`kind` are always present on a fetched/live
// message; `live` is stamped by SessionView on rows arriving over live SSE.
export interface PlaybackMessage extends Event {
  seq: number;
  live?: boolean;
}

// Context Causality (FR-CC) source: what likely drove this message, surfaced
// via the ⛓ button. Mirrors the (unexported) ChangeSource shape produced by
// server/causality.ts — see the report for the suggested shared-type addition.
export interface CausalitySource {
  seq: number;
  file: string | null;
  pattern: string | null;
  tool: string | null;
  confidence: number;
  reason: string | null;
}

export interface MessageCausality {
  sources: CausalitySource[];
}

export interface MessageRowProps {
  m: PlaybackMessage;
  selected: boolean;
  keyword: string;
  onClick: () => void;
  causality?: MessageCausality;
  onJump: (seq: number) => void;
}

// Labels/icons come from the shared canonical map (src/kinds.ts) so Playback and
// Refine stay consistent; only the per-view CSS class lives here.
const KIND_CLS: Record<DisplayKind, string> = {
  user: 'user', assistant: 'assistant', thinking: 'thinking', tool_use: 'tool', tool_result: 'tool-result', note: 'note',
};
interface KindMeta { icon: string; label: string; cls: string; }
const KIND_META: Record<string, KindMeta> = Object.fromEntries(
  (Object.keys(KIND_CLS) as DisplayKind[]).map((k) => [k, { icon: KIND_ICON[k], label: t(KIND_LABEL[k]), cls: KIND_CLS[k] }]),
);

export default function MessageRow({ m, selected, keyword, onClick, causality, onJump }: MessageRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
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
          {causality && causality.sources.length > 0 && (
            <button className="btn tiny ghost ctx-btn" title="Context Causality — what drove this change?"
              onClick={(e) => { e.stopPropagation(); setCtxOpen(!ctxOpen); }}>
              ⛓ {causality.sources.length}
            </button>
          )}
          {m.ts && <span className="msg-ts muted">{new Date(m.ts).toLocaleTimeString()}</span>}
        </span>
      </div>
      {ctxOpen && causality && (
        <div className="ctx-panel" onClick={(e) => e.stopPropagation()}>
          <div className="small muted">What likely drove this change:</div>
          {causality.sources.map((s) => (
            <div key={s.seq} className={`ctx-source ${s.confidence > 0.8 ? 'direct' : s.confidence < 0.3 ? 'background' : ''}`}
              onClick={() => onJump(s.seq)} title="Jump to source message">
              <span className="ctx-conf" style={{ width: `${s.confidence * 100}%` }} />
              <span className="ctx-label">{Math.round(s.confidence * 100)}% · {s.tool} {(s.file || s.pattern || '').split('/').pop()}</span>
              <span className="muted small"> — {s.reason}</span>
            </div>
          ))}
        </div>
      )}
      <div className="msg-body">{highlight(shown, keyword)}</div>
      {isLong && (
        <button className="btn ghost tiny" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
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
