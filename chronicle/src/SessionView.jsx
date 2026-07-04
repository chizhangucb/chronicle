import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import Timeline from './Timeline.jsx';
import CodePanel from './CodePanel.jsx';
import RefineMode from './RefineMode.jsx';
import ReplayMode from './ReplayMode.jsx';
import SecurityCheck from './SecurityCheck.jsx';

const FILTER_CHIPS = [
  { key: 'conversation', label: t('Conversation'), kinds: ['user', 'assistant'] },
  { key: 'tool', label: t('Tool'), kinds: ['tool_use', 'tool_result'] },
  { key: 'thinking', label: t('Thinking'), kinds: ['thinking'] },
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
  const [mode, setMode] = useState('playback'); // 'playback' | 'refine' | 'replay'
  const [securityOpen, setSecurityOpen] = useState(false);
  const [causality, setCausality] = useState(null); // {changes, mentioned}
  const [liveStatus, setLiveStatus] = useState('off'); // off | live | stopped | reconnecting
  const [newCount, setNewCount] = useState(0);
  const esRef = useRef(null);
  const atBottomRef = useRef(true);
  const listRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    api.sessionMessages(sessionId).then((d) => {
      setData(d);
      const firstUser = d.messages.find((m) => m.kind === 'user');
      setSelectedSeq(firstUser ? firstUser.seq : d.messages[0]?.seq ?? null);
    }).catch((e) => setError(String(e.message)));
  }, [sessionId]);

  // FR-CC: background causality analysis (local heuristic, no LLM)
  useEffect(() => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/causality`)
      .then((r) => r.json()).then(setCausality).catch(() => {});
  }, [sessionId]);

  // FR-LS-2: auto-activate live watching when the session file was recently written
  useEffect(() => {
    if (!data?.liveCandidate) return;
    let retries = 0;
    let es;
    function connect() {
      es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/live`);
      esRef.current = es;
      es.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'status') setLiveStatus(msg.status === 'live' ? 'live' : 'stopped');
        if (msg.type === 'messages') {
          retries = 0;
          setData((cur) => ({ ...cur, messages: [...cur.messages, ...msg.events.map((e, i) => ({ ...e, live: true }))] }));
          const pane = listRef.current;
          if (pane && atBottomRef.current) {
            requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
          } else {
            setNewCount((n) => n + msg.events.length);
          }
        }
      };
      es.onerror = () => {
        es.close();
        if (retries++ < 3) { // FR-LS-5: exponential backoff, then manual
          setLiveStatus('reconnecting');
          setTimeout(connect, 1000 * 2 ** retries);
        } else setLiveStatus('stopped');
      };
    }
    connect();
    return () => { esRef.current?.close(); setLiveStatus('off'); }; // FR-LS-7 auto-stop
  }, [data?.liveCandidate, sessionId]);

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

  // FR-COMPAT-2: degrade gracefully on huge sessions — render a window of
  // messages around the selection instead of the full list.
  const WINDOW = 400;
  const selIdx = Math.max(0, visible.findIndex((m) => m.seq === selectedSeq));
  const winStart = visible.length > WINDOW ? Math.max(0, Math.min(selIdx - WINDOW / 2, visible.length - WINDOW)) : 0;
  const winEnd = Math.min(visible.length, winStart + WINDOW);
  const windowed = visible.slice(winStart, winEnd);

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
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setMode('playback'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setMode('refine'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); setMode('replay'); }
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
        <div className="mode-switch">
          <button className={`chip ${mode === 'playback' ? 'on' : ''}`} onClick={() => setMode('playback')} title="Playback Mode (⌘2)">▶ {t('Playback')}</button>
          <button className={`chip ${mode === 'refine' ? 'on' : ''}`} onClick={() => setMode('refine')} title="Refine Mode (⌘3)">✂ {t('Refine')}</button>
          <button className={`chip ${mode === 'replay' ? 'on' : ''}`} onClick={() => setMode('replay')} title="Replay Mode (⌘4)">⟳ {t('Replay')}</button>
          <button className="chip security" onClick={() => setSecurityOpen(true)}>🛡 {t('Security Check')}</button>
          {liveStatus !== 'off' && (
            <span className={`pill live-pill ${liveStatus}`} title="Live streaming from the session log"
              onClick={() => liveStatus === 'stopped' && setLiveStatus('off') /* triggers re-effect via key below */}>
              {liveStatus === 'live' ? '● LIVE' : liveStatus === 'reconnecting' ? '◌ Reconnecting…' : '○ Stopped'}
            </span>
          )}
        </div>
        {mode === 'playback' && <><div className="filter-chips">
          {FILTER_CHIPS.map((c) => (
            <button key={c.key} className={`chip ${chips.has(c.key) ? 'on' : ''}`}
              onClick={() => setChips((prev) => {
                const next = new Set(prev);
                next.has(c.key) ? next.delete(c.key) : next.add(c.key);
                return next;
              })}>{c.label}</button>
          ))}
          {(chips.size > 0 || debounced) && (
            <button className="chip clear" onClick={() => { setChips(new Set()); setKeyword(''); }}>{t('Clear filter')}</button>
          )}
        </div>
        <input ref={searchRef} className="search" placeholder={t('Search messages…  ⌘F')}
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <span className="muted small">Match: {visible.length}/{messages.length}</span></>}
      </div>

      {mode === 'playback' && <>
        <div className="panes">
          <div className="conv-pane" ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              if (atBottomRef.current) setNewCount(0);
            }}>
            {newCount > 0 && (
              <button className="btn primary new-msgs" onClick={() => {
                listRef.current.scrollTop = listRef.current.scrollHeight;
                setNewCount(0);
              }}>↓ {newCount} new message{newCount > 1 ? 's' : ''}</button>
            )}
            {winStart > 0 && (
              <button className="btn small window-btn" onClick={() => selectMessage(visible[Math.max(0, winStart - WINDOW / 2)].seq, true)}>
                ↑ {winStart.toLocaleString()} earlier messages
              </button>
            )}
            {windowed.map((m) => (
              <MessageRow key={m.seq} m={m} selected={m.seq === selectedSeq}
                keyword={debounced} onClick={() => selectMessage(m.seq)}
                causality={causality?.changes.find((c) => c.seq === m.seq)}
                onJump={(seq) => selectMessage(seq, true)} />
            ))}
            {winEnd < visible.length && (
              <button className="btn small window-btn" onClick={() => selectMessage(visible[Math.min(visible.length - 1, winEnd + WINDOW / 2 - 1)].seq, true)}>
                ↓ {(visible.length - winEnd).toLocaleString()} later messages
              </button>
            )}
            {!visible.length && <div className="muted center pad8">No messages match the current filter.</div>}
          </div>
          <CodePanel projectId={data.project.id} commit={commit} noRepo={noRepo || !data.git?.isRepo} />
        </div>
        <Timeline messages={messages} commits={data.commits}
          currentTs={selected?.ts} currentCommit={commit} onSeek={seekTs} />
      </>}

      {mode === 'refine' && (
        <RefineMode messages={messages} session={data.session} project={data.project} />
      )}

      {mode === 'replay' && <ReplayMode sessionId={sessionId} />}

      {securityOpen && (
        <SecurityCheck sessionId={sessionId} projectName={data.project.name}
          onClose={() => setSecurityOpen(false)} />
      )}
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

function MessageRow({ m, selected, keyword, onClick, causality, onJump }) {
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
