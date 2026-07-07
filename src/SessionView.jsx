import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import Timeline from './Timeline.jsx';
import CodePanel from './CodePanel.jsx';
import RefineMode from './RefineMode.jsx';
import ReplayMode from './ReplayMode.jsx';
import SecurityCheck from './SecurityCheck.jsx';
import { contextWindowFor } from './models.js';
import { SessionPicker } from './ProjectDetail.jsx';

const FILTER_CHIPS = [
  { key: 'conversation', label: t('Conversation'), kinds: ['user', 'assistant'] },
  { key: 'tool', label: t('Tool'), kinds: ['tool_use', 'tool_result'] },
  { key: 'thinking', label: t('Thinking'), kinds: ['thinking'] },
];

export default function SessionView({ sessionId, onBack, onLiveChange, onRailChange, onSwitchSession }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSeq, setSelectedSeq] = useState(null);
  const [chips, setChips] = useState(new Set());
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [commit, setCommit] = useState(null); // {hash, date, subject} | null
  const [noRepo, setNoRepo] = useState(false);
  const [mode, setMode] = useState('overview'); // 'overview' | 'playback' | 'refine' | 'replay'
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

  // Surface live status app-wide (topbar pill) while this session is open.
  useEffect(() => {
    onLiveChange?.(liveStatus === 'off' ? null : { status: liveStatus, sessionId });
    return () => onLiveChange?.(null);
  }, [liveStatus, sessionId]);

  // Register the session mode rail with the global sidebar (Chronicle-style).
  useEffect(() => {
    if (!data) return;
    onRailChange?.({
      modes: [
        { key: 'overview', icon: '📊', label: t('Overview'), title: 'Session Overview (⌘1)' },
        { key: 'playback', icon: '▶', label: t('Playback'), title: 'Playback Mode (⌘2)' },
        { key: 'refine', icon: '✂', label: t('Refine'), title: 'Refine Mode (⌘3)' },
        { key: 'replay', icon: '⟳', label: t('Replay'), title: 'Replay Mode (⌘4)' },
      ],
      active: mode,
      securityOpen,
      select: (k) => (k === 'security-check' ? setSecurityOpen(true) : setMode(k)),
    });
    return () => onRailChange?.(null);
  }, [data === null, mode, securityOpen]);

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
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setMode('overview'); }
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
      <div className="session-main">
      <div className="session-toolbar">
        <div className="crumbs">
          <button className="crumb" title={t('Project home page')} onClick={onBack}>📁 {data.project.name}</button>
          <span className="crumb-sep">›</span>
          <SessionSwitcher projectId={data.project.id} current={{ ...data.session, message_count: messages.length, first_prompt: data.session.first_prompt }}
            onSwitch={onSwitchSession} />
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

      {mode === 'overview' && (
        <OverviewMode data={data} liveStatus={liveStatus} onDeleted={onBack} />
      )}

      {mode === 'refine' && (
        <RefineMode messages={messages} session={data.session} project={data.project} />
      )}

      {mode === 'replay' && <ReplayMode sessionId={sessionId} />}

      {securityOpen && (
        <SecurityCheck sessionId={sessionId} projectName={data.project.name}
          onClose={() => setSecurityOpen(false)} />
      )}
      </div>
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

// ---- Overview mode: per-session stats dashboard (the session "home page") ----

const FRIENDLY_CALL = {
  Bash: 'Shell Command', Write: 'Write File', Edit: 'Edit File', Read: 'Read File',
  Skill: 'Skill Invoke', Grep: 'Search', Glob: 'Search', WebFetch: 'Web Fetch', WebSearch: 'Web Search',
};
const DONUT_COLORS = ['#4f8ef7', '#34c98e', '#e5a54b', '#a78bfa', '#f472b6', '#38bdf8', '#e5684b', '#8b98a9'];
const DELETABLE_SOURCES = new Set(['claude-code', 'codex', 'copilot-chat']);

function isErrorResult(m) {
  return m.kind === 'tool_result'
    && /^\s*(error|fatal|traceback)|tool_use_error|exit code [1-9]|command failed|permission denied/i
      .test((m.text || '').slice(0, 200));
}

// Session ID with one-click copy (shown on the session home page).
function SessionIdChip({ id }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(id); } catch {
      const ta = document.createElement('textarea');
      ta.value = id; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <span className="session-id-chip" title={t('Session ID')}>
      <span className="mono-path small">{id}</span>
      <button className={`btn tiny ${copied ? 'ok-btn' : ''}`} onClick={copy}>
        {copied ? `✓ ${t('Copied!')}` : `⧉ ${t('Copy')}`}
      </button>
    </span>
  );
}

// Breadcrumb session dropdown: lazily loads the project's session list.
function SessionSwitcher({ projectId, current, onSwitch }) {
  const [sessions, setSessions] = useState(null);
  useEffect(() => {
    api.project(projectId).then((d) => setSessions(d.sessions)).catch(() => setSessions([]));
  }, [projectId]);
  return (
    <SessionPicker sessions={sessions || []} loading={sessions === null} current={current}
      onPick={(sid) => { if (sid !== current.id) onSwitch?.(sid); }} />
  );
}

function fmtCtx(tokens) {
  if (tokens >= 1e6) return `${tokens % 1e6 === 0 ? tokens / 1e6 : (tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

function OverviewMode({ data, liveStatus, onDeleted }) {
  const { session, messages } = data;

  const stats = useMemo(() => {
    const toolUses = messages.filter((m) => m.kind === 'tool_use');
    const errorIds = new Set(messages.filter(isErrorResult).map((m) => m.tool_use_id).filter(Boolean));
    const errors = messages.filter(isErrorResult).length;
    const dist = new Map();
    for (const m of toolUses) dist.set(m.tool_name || 'unknown', (dist.get(m.tool_name || 'unknown') || 0) + 1);
    const distSorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
    const top = distSorted.slice(0, 7);
    const otherCount = distSorted.slice(7).reduce((s, [, n]) => s + n, 0);
    if (otherCount) top.push(['other', otherCount]);
    const timeline = messages
      .filter((m) => m.kind === 'user' || m.kind === 'tool_use')
      .slice(0, 12)
      .map((m) => ({
        seq: m.seq, ts: m.ts,
        label: m.kind === 'user' ? 'User Prompt' : (FRIENDLY_CALL[m.tool_name] || m.tool_name || 'Tool'),
        preview: m.kind === 'user' ? (m.text || '').slice(0, 90) : summarizeToolInput(m.tool_name, m.tool_input).slice(0, 90),
      }));
    return { toolUses, errors, errorIds, top, timeline };
  }, [messages]);

  const durationMs = session.started_at && session.ended_at
    ? new Date(session.ended_at) - new Date(session.started_at) : null;
  const dur = durationMs === null ? '—'
    : durationMs < 3600000 ? `${Math.round(durationMs / 60000)}m`
    : `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`;

  const totalCalls = stats.toolUses.length;
  let acc = 0;
  const gradient = stats.top.map(([, n], i) => {
    const from = (acc / Math.max(1, totalCalls)) * 360; acc += n;
    const to = (acc / Math.max(1, totalCalls)) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${to}deg`;
  }).join(', ');

  const DETAIL_CAP = 100;

  // Context-window usage bar: real usage vs the model's window (static table).
  const model = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].model) return messages[i].model;
    return null;
  }, [messages]);
  const ctxWindow = contextWindowFor(model);
  const ctxPct = ctxWindow && session.context_tokens > 0
    ? (session.context_tokens / ctxWindow) * 100 : null;
  const ctxLevel = ctxPct === null ? null
    : ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'high' : ctxPct >= 50 ? 'mid' : 'low';

  return (
    <div className="page overview-page">
      <div className="ov-title-row">
        <h3 className="ov-title">📊 {t('Session Statistics')}{session.started_at ? ` — ${new Date(session.started_at).toLocaleString()}` : ''}</h3>
        <SessionIdChip id={session.id} />
      </div>
      <div className="analytics-row">
        <div className="card stat"><div className="stat-num">{dur}</div><div className="muted small">{t('Total Duration')}</div></div>
        <div className="card stat"><div className="stat-num">{messages.length}</div><div className="muted small">{t('Messages')}</div></div>
        <div className="card stat"><div className="stat-num">{totalCalls}</div><div className="muted small">{t('Tool Calls')}</div></div>
        <div className="card stat"><div className={`stat-num ${stats.errors ? 'bad' : ''}`}>{stats.errors}</div><div className="muted small">{t('Errors')}</div></div>
        {session.context_tokens > 0 && (
          <div className="card stat" title={t('Context window size at the last message (real usage from the session log)')}>
            <div className="stat-num">{session.context_tokens >= 1e6 ? `${(session.context_tokens / 1e6).toFixed(1)}M` : `${Math.round(session.context_tokens / 1000)}k`}</div>
            <div className="muted small">{t('Context')}</div>
          </div>
        )}
      </div>

      {ctxPct !== null && (
        <div className="card ov-block ctx-block">
          <div className="ctx-head">
            <strong>{t('Context Window')}</strong>
            <span className="muted small">{model}</span>
            <span className={`ctx-pct ${ctxLevel}`}>
              {fmtCtx(session.context_tokens)} / {fmtCtx(ctxWindow)} · {Math.round(ctxPct)}%
            </span>
          </div>
          <div className="ctx-bar" title={t('Context window size at the last message (real usage from the session log)')}>
            <span className={`ctx-fill ${ctxLevel}`} style={{ width: `${Math.min(100, ctxPct)}%` }} />
          </div>
        </div>
      )}

      <div className="card ov-block">
        <div className="ov-block-head"><strong>{t('Call Timeline')}</strong>
          <span className="muted small">{Math.min(12, stats.timeline.length)}/{messages.filter((m) => m.kind === 'user' || m.kind === 'tool_use').length} {t('events')}</span>
        </div>
        {stats.timeline.map((e) => (
          <div key={e.seq} className="ov-tl-row">
            <span className="ov-tl-dot" />
            <span className="ov-tl-label">{e.label}</span>
            {e.ts && <span className="muted small">{new Date(e.ts).toLocaleTimeString()}</span>}
            {e.preview && <span className="muted small ov-tl-preview">{e.preview}</span>}
          </div>
        ))}
      </div>

      <div className="ov-cols">
        <div className="card ov-block">
          <div className="ov-block-head"><strong>{t('Tool Distribution')}</strong></div>
          <div className="ov-donut-wrap">
            {totalCalls > 0 && <div className="ov-donut" style={{ background: `conic-gradient(${gradient})` }} />}
            <div>
              {stats.top.map(([name, n], i) => (
                <div key={name} className="ov-legend-row">
                  <span className="ov-legend-dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span>{name}</span>
                  <span className="muted small">{Math.round((n / Math.max(1, totalCalls)) * 100)}%</span>
                </div>
              ))}
              {!totalCalls && <div className="muted small">{t('No tool calls recorded.')}</div>}
              <div className="muted small" style={{ marginTop: 6 }}>{t('Total')} {totalCalls} {t('calls')}</div>
            </div>
          </div>
        </div>

        <div className="card ov-block">
          <div className="ov-block-head"><strong>{t('Call Details')}</strong>
            <span className="muted small">{Math.min(DETAIL_CAP, totalCalls)}/{totalCalls} {t('calls')}</span>
          </div>
          <div className="ov-details">
            {stats.toolUses.slice(0, DETAIL_CAP).map((m) => (
              <div key={m.seq} className="ov-detail-row">
                <span className={stats.errorIds.has(m.tool_use_id) ? 'bad' : 'ok'}>{stats.errorIds.has(m.tool_use_id) ? '✗' : '✓'}</span>
                <span className="ov-tl-label">{FRIENDLY_CALL[m.tool_name] || m.tool_name || 'Tool'}</span>
                <span className="muted small ov-tl-preview">{summarizeToolInput(m.tool_name, m.tool_input).slice(0, 100) || '-'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <SourceFileZone session={session} liveStatus={liveStatus} onDeleted={onDeleted} />
    </div>
  );
}

// Danger zone: delete the original log file, the Chronicle copy, or both.
// Every action is a two-step inline confirm; deletion is permanent (no backup).
function SourceFileZone({ session, liveStatus, onDeleted }) {
  const [confirming, setConfirming] = useState(null); // null | 'file' | 'everywhere' | 'chronicle'
  const [busy, setBusy] = useState(false);
  const [fileDeleted, setFileDeleted] = useState(false);
  const [error, setError] = useState(null);
  const deletable = DELETABLE_SOURCES.has(session.source);
  const live = liveStatus === 'live' || liveStatus === 'reconnecting';

  const CONFIRM_TEXT = {
    file: t('Permanently delete the original log file from disk? This cannot be undone. The imported copy stays in Chronicle.'),
    everywhere: t('Permanently delete the original log file AND the imported copy in Chronicle? This cannot be undone.'),
    chronicle: t('Delete the imported copy from Chronicle? The original log stays on disk and can be re-imported later.'),
  };

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      if (action === 'file') {
        await api.deleteSessionSource(session.id);
        setFileDeleted(true);
        setConfirming(null);
      } else {
        await api.deleteSession(session.id, action === 'everywhere');
        onDeleted(); // session no longer exists — back to the project page
      }
    } catch (e) { setError(String(e.message)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card ov-block ov-danger">
      <div className="ov-block-head"><strong>{t('Source file')}</strong></div>
      <div className="muted small mono-path">{session.file_path}</div>
      {fileDeleted && (
        <div className="ok small" style={{ marginTop: 8 }}>
          ✓ {t('Source file deleted.')} {t('The imported copy stays in Chronicle.')}
        </div>
      )}
      {!deletable && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {t('This source keeps all sessions in shared storage — its file cannot be deleted per-session.')}
        </div>
      )}
      {live ? (
        <div className="muted small" style={{ marginTop: 8 }}>● {t('Session is live — deletion is disabled while the log is being written.')}</div>
      ) : confirming ? (
        <div className="ov-confirm">
          <span className="small">{CONFIRM_TEXT[confirming]}</span>
          <button className="btn small danger-btn" disabled={busy} onClick={() => run(confirming)}>
            {busy ? t('Deleting…') : t('Confirm delete')}
          </button>
          <button className="btn small ghost" disabled={busy} onClick={() => setConfirming(null)}>{t('Cancel')}</button>
        </div>
      ) : (
        <div className="ov-actions">
          {deletable && !fileDeleted && (
            <button className="btn small danger-btn" onClick={() => setConfirming('file')}>
              🗑 {t('Delete source file')}
            </button>
          )}
          {deletable && !fileDeleted && (
            <button className="btn small danger-btn" onClick={() => setConfirming('everywhere')}>
              🗑 {t('Delete everywhere')}
            </button>
          )}
          <button className="btn small danger-btn" onClick={() => setConfirming('chronicle')}>
            🗑 {t('Delete from Chronicle')}
          </button>
        </div>
      )}
      {error && <div className="error-banner small">{error}</div>}
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
