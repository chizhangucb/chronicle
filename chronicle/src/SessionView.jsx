import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import Timeline from './Timeline.jsx';
import CodePanel from './CodePanel.jsx';

const FILTER_CHIPS = [
  { key: 'conversation', label: 'Conversation', kinds: ['user', 'assistant'] },
  { key: 'tool', label: 'Tool', kinds: ['tool_use', 'tool_result'] },
  { key: 'thinking', label: 'Thinking', kinds: ['thinking'] },
];

export default function SessionView({ sessionId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSeq, setSelectedSeq] = useState(null);
  const [chips, setChips] = useState(new Set());
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [commit, setCommit] = useState(null); // {hash, date, subject} | null
  const [noRepo, setNoRepo] = useState(false);
  const listRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    api.sessionMessages(sessionId).then((d) => {
      setData(d);
      const firstUser = d.messages.find((m) => m.kind === 'user');
      setSelectedSeq(firstUser ? firstUser.seq : d.messages[0]?.seq ?? null);
    }).catch((e) => setError(String(e.message)));
  }, [sessionId]);

  // FR-FLT-3: 300ms debounce on keyword
  useEffect(() => {
    const t = setTimeout(() => setDebounced(keyword.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  const messages = data?.messages ?? [];
  const activeKinds = useMemo(() => {
    if (!chips.size) return null; // no filter → all
    const set = new Set();
    FILTER_CHIPS.filter((c) => chips.has(c.key)).forEach((c) => c.kinds.forEach((k) => set.add(k)));
    return set;
  }, [chips]);

  const visible = useMemo(() => messages.filter((m) => {
    if (activeKinds && !activeKinds.has(m.kind)) return false;
    if (debounced) {
      const hay = `${m.text || ''} ${m.tool_name || ''} ${m.tool_input || ''}`.toLowerCase();
      if (!hay.includes(debounced)) return false;
    }
    return true;
  }), [messages, activeKinds, debounced]);

  const selected = messages.find((m) => m.seq === selectedSeq) || null;

  // FR-TT-4: snapshot = nearest preceding commit for the selected message's time
  useEffect(() => {
    if (!data || !selected?.ts) return;
    let stale = false;
    api.gitAt(data.project.id, selected.ts).then((r) => {
      if (stale) return;
      if (r.noRepo) { setNoRepo(true); setCommit(null); }
      else { setNoRepo(false); setCommit(r.commit); }
    }).catch(() => {});
    return () => { stale = true; };
  }, [data, selectedSeq]);

  // Cmd/Ctrl+F focuses search; Esc clears
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape') { setKeyword(''); searchRef.current?.blur(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function selectMessage(seq, scroll = false) {
    setSelectedSeq(seq);
    if (scroll) {
      requestAnimationFrame(() => {
        listRef.current?.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  // Timeline seek: pick nearest visible message to a timestamp
  function seekTs(tsMillis) {
    const pool = visible.length ? visible : messages;
    let best = null, bestD = Infinity;
    for (const m of pool) {
      if (!m.ts) continue;
      const d = Math.abs(new Date(m.ts) - tsMillis);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) selectMessage(best.seq, true);
  }

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!data) return <div className="page center muted">Loading session…</div>;

  return (
    <div className="session-view">
      <div className="session-toolbar">
        <button className="btn ghost" onClick={onBack}>← {data.project.name}</button>
        <div className="filter-chips">
          {FILTER_CHIPS.map((c) => (
            <button key={c.key} className={`chip ${chips.has(c.key) ? 'on' : ''}`}
              onClick={() => setChips((prev) => {
                const next = new Set(prev);
                next.has(c.key) ? next.delete(c.key) : next.add(c.key);
                return next;
              })}>{c.label}</button>
          ))}
          {(chips.size > 0 || debounced) && (
            <button className="chip clear" onClick={() => { setChips(new Set()); setKeyword(''); }}>Clear filter</button>
          )}
        </div>
        <input ref={searchRef} className="search" placeholder="Search messages…  ⌘F"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <span className="muted small">Match: {visible.length}/{messages.length}</span>
      </div>

      <div className="panes">
        <div className="conv-pane" ref={listRef}>
          {visible.map((m) => (
            <MessageRow key={m.seq} m={m} selected={m.seq === selectedSeq}
              keyword={debounced} onClick={() => selectMessage(m.seq)} />
          ))}
          {!visible.length && <div className="muted center pad8">No messages match the current filter.</div>}
        </div>
        <CodePanel projectId={data.project.id} commit={commit} noRepo={noRepo || !data.git?.isRepo} />
      </div>

      <Timeline messages={messages} commits={data.commits}
        currentTs={selected?.ts} currentCommit={commit} onSeek={seekTs} />
    </div>
  );
}

const KIND_META = {
  user: { icon: '👤', label: 'You', cls: 'user' },
  assistant: { icon: '✳', label: 'AI', cls: 'assistant' },
  thinking: { icon: '💭', label: 'Thinking', cls: 'thinking' },
  tool_use: { icon: '🔧', label: 'Tool', cls: 'tool' },
  tool_result: { icon: '↩', label: 'Result', cls: 'tool-result' },
};

function MessageRow({ m, selected, keyword, onClick }) {
  const [expanded, setExpanded] = useState(false);
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
    <div data-seq={m.seq} className={`msg ${meta.cls} ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="msg-head">
        <span className="msg-kind">{meta.icon} {title || meta.label}</span>
        {m.ts && <span className="msg-ts muted">{new Date(m.ts).toLocaleTimeString()}</span>}
      </div>
      <div className="msg-body">{highlight(shown, keyword)}</div>
      {isLong && (
        <button className="btn ghost tiny" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
          {expanded ? 'Show less' : `Show all (${body.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function summarizeToolInput(name, inputJson) {
  try {
    const input = JSON.parse(inputJson || '{}');
    if (input.file_path) return input.file_path;
    if (input.command) return input.command;
    if (input.pattern) return input.pattern;
    if (input.query) return input.query;
    const s = JSON.stringify(input);
    return s === '{}' ? '' : s;
  } catch { return inputJson || ''; }
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
