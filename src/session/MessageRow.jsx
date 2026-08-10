import React, { useState } from 'react';
import { t } from '../i18n.js';
import { KIND_ICON, KIND_LABEL } from '../kinds.ts';
import { summarizeToolInput } from './stats.js';

// Labels/icons come from the shared canonical map (src/kinds.js) so Playback and
// Refine stay consistent; only the per-view CSS class lives here.
const KIND_CLS = { user: 'user', assistant: 'assistant', thinking: 'thinking', tool_use: 'tool', tool_result: 'tool-result' };
const KIND_META = Object.fromEntries(
  Object.keys(KIND_CLS).map((k) => [k, { icon: KIND_ICON[k], label: t(KIND_LABEL[k]), cls: KIND_CLS[k] }])
);

export default function MessageRow({ m, selected, keyword, onClick, causality, onJump }) {
  const [expanded, setExpanded] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const meta = KIND_META[m.kind] || { icon: '•', label: m.kind, cls: '' };
  let body = m.text || '';
  let title = null;
  if (m.kind === 'tool_use') {
    title = m.tool_name;
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
          {causality?.sources.length > 0 && (
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

function highlight(text, keyword) {
  if (!keyword) return text;
  const parts = [];
  let i = 0;
  const lower = text.toLowerCase();
  let idx;
  while ((idx = lower.indexOf(keyword, i)) !== -1 && parts.length < 200) {
    parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + keyword.length)}</mark>);
    i = idx + keyword.length;
  }
  parts.push(text.slice(i));
  return parts;
}
