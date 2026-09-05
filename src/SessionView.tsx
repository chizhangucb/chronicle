import React, { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import Timeline from './Timeline.jsx';
import CodePanel from './CodePanel.jsx';
import RefineMode from './RefineMode.jsx';
import SecurityCheck from './SecurityCheck.jsx';
import { SessionPicker, sessionDisplayName } from './ProjectDetail.jsx';
import { type PlaybackMessage, type MessageCausality } from './session/MessageRow.tsx';
import WindowedConvPane from './session/WindowedConvPane.tsx';
import OverviewMode from './session/OverviewMode.tsx';
import { errorDrillIn, subagentRunList, fmtTokNum, fmtDur } from './session/stats.ts';
import ContentTab from './ContentTab.tsx';
import { useResizable } from './useResizable.ts';
import type { ProjectDetail, ProjectSessionSummary } from './api.js';
import type { DeletedEntry } from './SessionSelect.tsx';

// ── Shapes for the GET /api/sessions/:id/messages payload ──────────────────
// Duplicated from server/db.ts + server/git.ts + server/causality.ts rather than
// imported: tsconfig.client.json's program only includes src/**  + shared/**, so
// it cannot see server/**. See the task report for the suggested shared-type
// addition (a client-usable Session/Project/CausalityResult contract).

// Full `sessions` row shape (mirrors server/db.ts SessionRow). `source` is a
// plain `string` (not the narrower `SourceId` union) to match the canonical
// api.ts `Session`/server/db.ts `SessionRow` — the DB column is untyped TEXT.
export interface Session {
  id: string;
  project_id: number;
  source: string;
  file_path: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  first_prompt: string | null;
  context_tokens: number | null;
  name: string | null;
  summary: string | null;
  usage: string | null;
  sidechain_count: number;
  imported_at: string | null;
  agent_active_ms: number | null;
  engaged_ms: number | null;
}

// Full `projects` row shape (mirrors server/db.ts ProjectRow / shared Project).
export interface ProjectInfo {
  id: number;
  path: string;
  name: string;
  created_at?: string;
}

// Mirrors server/git.ts Commit / RepoInfo.
export interface CommitInfo {
  hash: string;
  date: string;
  subject: string;
  beforeHistory?: boolean;
}
export interface RepoInfo {
  isRepo: boolean;
  commitCount?: number;
  branch?: string | null;
}

// Mirrors server/causality.ts's (unexported) ChangeRecord/CausalityResult.
export interface CausalityChange {
  seq: number;
  ts: string | null;
  file: string;
  tool: string | null;
  sources: MessageCausality['sources'];
}
export interface CausalityData {
  changes: CausalityChange[];
  readCount: number;
  mentioned: Record<number, (string | null)[]>;
}

export interface SessionData {
  session: Session;
  project: ProjectInfo;
  messages: PlaybackMessage[];
  commits: CommitInfo[];
  git: RepoInfo | null;
  liveCandidate: boolean;
}

export type LiveStatus = 'off' | 'live' | 'stopped' | 'reconnecting';
export interface LiveChangeInfo { status: LiveStatus; sessionId: string; }

export type SessionMode = 'overview' | 'playback' | 'refine' | 'subagent' | 'content';

// Playback's chat/right-group drag handle (spec §2.3 task-8) — reuses
// `useResizable` (App.tsx's sidebar / HomePage.tsx's project rail already
// use it) for the persisted width + all the drag robustness it already
// hardened: parseInt/NaN-guarded/clamped/try-caught localStorage
// read+write, pointer capture, pointercancel handling, a `buttons===0`
// self-heal, and unmount-safe teardown — see useResizable.ts's header
// comment for exactly which failure modes each guards against. A bespoke
// reimplementation here would either skip those guards or duplicate them
// with a second chance to get them wrong.
//
// `min`/`max` are static, like the two existing callers' — the REAL,
// viewport-relative ceiling (so a huge persisted width from a wide monitor
// can't reopen the clipping bug on a narrow one, and so a live window
// resize is safe even without a fresh drag) is enforced by the `min()` /
// `calc()` in the inline `gridTemplateColumns` below, not by JS measuring
// `.panes`' DOM rect — `.panes` isn't mounted yet at the hook's first
// render, so a live-measurement-based dynamic max can't run at init time
// anyway. `PLAYBACK_SPLIT_RESERVED` = the handle (24px) + the right
// group's own floor (200px file-tree + 320px code-view, from
// `.pb-grid .code-body`'s `minmax()`s below) — the chat column may never
// eat into that reserve, at any width, dragged or not.
const PLAYBACK_SPLIT_KEY = 'chronicle-playback-split';
const PLAYBACK_SPLIT_MIN = 280;
const PLAYBACK_SPLIT_RESERVED = 544;

export interface RailModeDef { key: SessionMode; icon: string; label: string; title: string; }
export interface RailState {
  modes: RailModeDef[];
  active: SessionMode;
  securityOpen: boolean;
  select: (k: SessionMode | 'security-check') => void;
}

export interface SessionViewProps {
  sessionId: string;
  // `undo`: set when navigating back after an Overview single-session delete,
  // so the destination view (project/home) can surface the shared undo toast.
  // `projectId`: the owning project (read from the fetched session data),
  // so the caller can navigate to `/project/:id` without having to have
  // threaded it in via route params (a `/session/:id` deep link has none).
  onBack: (undo?: DeletedEntry, projectId?: number) => void;
  onLiveChange?: (info: LiveChangeInfo | null) => void;
  onRailChange?: (rail: RailState | null) => void;
  onSwitchSession?: (sessionId: string) => void;
}

interface FilterChip {
  key: string;
  label: string;
  kinds: PlaybackMessage['kind'][];
}

const FILTER_CHIPS: FilterChip[] = [
  { key: 'conversation', label: t('Conversation'), kinds: ['user', 'assistant'] },
  { key: 'tool', label: t('Tool'), kinds: ['tool_use', 'tool_result'] },
  { key: 'thinking', label: t('Thinking'), kinds: ['thinking'] },
];

export default function SessionView({ sessionId, onBack, onLiveChange, onRailChange, onSwitchSession }: SessionViewProps): JSX.Element {
  const [data, setData] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  // Errors KPI drill-in (OverviewMode → Playback): true while Playback is
  // restricted to erroring tool_result rows + their paired tool_use calls,
  // bypassing the kind chips (see `visible` below). Independent of `chips`
  // because it's a row-identity filter (tool_use_id pairing), not a kind filter.
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [commit, setCommit] = useState<CommitInfo | null>(null);
  const [noRepo, setNoRepo] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [mode, setMode] = useState<SessionMode>('overview');
  // Two-level 'subagent' drill-in, set by OverviewMode's Subagents card;
  // both null when not drilled in. NOT part of the sidebar rail's `modes` —
  // reached only via the Overview card.
  // Level 1: `subagentType` set, `subagentRunId` null — the RUN LIST for that
  // agent_type (one row per agent_id).
  // Level 2: both set — that one run's transcript (filtered by agent_id, not
  // agent_type — many runs can share a type).
  const [subagentType, setSubagentType] = useState<string | null>(null);
  const [subagentRunId, setSubagentRunId] = useState<string | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [causality, setCausality] = useState<CausalityData | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('off');
  const [newCount, setNewCount] = useState(0);
  const [syncingSession, setSyncingSession] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const atBottomRef = useRef(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chatSplit = useResizable({ storageKey: PLAYBACK_SPLIT_KEY, fallback: 420, min: PLAYBACK_SPLIT_MIN, max: 900, edge: 'right' });
  const searchRef = useRef<HTMLInputElement | null>(null);
  const syncRef = useRef<(() => void) | null>(null); // always points at the latest syncThisSession (for the ⇧⌘U shortcut)
  // Whether the CURRENT selectedSeq was set via the Timeline's own scrub/seek,
  // vs some other path (message card click, window-jump button). Overwritten
  // synchronously by every `selectMessage` call, right alongside
  // `setSelectedSeq` — never a one-shot flag that needs separate consumption,
  // so it can't go stale the way a "did I just cause this" latch can (see
  // Timeline.tsx's comment on `selectionFromTimeline` for the bug this
  // replaced: a latch set in Timeline itself stayed true forever if a seek
  // resolved to the already-selected message, since the effect that would
  // reset it never fired — the NEXT genuinely external change then
  // misread the stale flag and left the playhead frozen).
  const selectionFromTimelineRef = useRef(false);

  useEffect(() => {
    api.sessionMessages(sessionId).then((d: SessionData) => {
      setData(d);
      const firstUser = d.messages.find((m) => m.kind === 'user');
      setSelectedSeq(firstUser ? firstUser.seq : d.messages[0]?.seq ?? null);
    }).catch((e: Error) => setError(String(e.message)));
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
    let es: EventSource;
    function connect() {
      es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/live`);
      esRef.current = es;
      es.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'status') setLiveStatus(msg.status === 'live' ? 'live' : 'stopped');
        if (msg.type === 'messages') {
          retries = 0;
          setData((cur) => (cur ? { ...cur, messages: [...cur.messages, ...msg.events.map((e: PlaybackMessage) => ({ ...e, live: true }))] } : cur));
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

  // Register the session mode rail with the global sidebar.
  useEffect(() => {
    if (!data) return;
    onRailChange?.({
      modes: [
        { key: 'overview', icon: '⬚', label: t('Overview'), title: 'Session Overview (⌘1)' },
        { key: 'playback', icon: '▶', label: t('Playback'), title: 'Playback Mode (⌘2)' },
        { key: 'refine', icon: '✂', label: t('Refine'), title: 'Refine Mode (⌘3)' },
      ],
      active: mode,
      securityOpen,
      select: (k) => (k === 'security-check' ? setSecurityOpen(true) : setMode(k)),
    });
    return () => onRailChange?.(null);
  }, [data === null, mode, securityOpen]);

  // FR-FLT-3: 300ms debounce on keyword
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  // Sidechain (subagent) rows are imported since v0.2 but EXCLUDED from the
  // default playback/refine/overview lists; durations and Cost & Usage include
  // them via the server-stored numbers.
  const messages = useMemo(() => (data?.messages ?? []).filter((m) => !m.is_sidechain), [data]);
  // 'subagent' drill-in level 1: the run list for `subagentType`, read from
  // the UNFILTERED session messages (sidechains are excluded from `messages`
  // above). subagentRunList groups by agent_id, not agent_type — many runs
  // share a type, which is exactly what the run list is for.
  const subagentRunRows = useMemo(
    () => (subagentType ? subagentRunList(data?.messages ?? [], subagentType) : []),
    [data, subagentType],
  );
  // Level 2: that ONE run's transcript, filtered by agent_id (replaces the
  // old agent_type filter — a type can have many runs, so filtering by type
  // alone would show every run's messages interleaved).
  const subagentMessages = useMemo(
    () => (data?.messages ?? []).filter((m) => m.is_sidechain && m.agent_id === subagentRunId),
    [data, subagentRunId],
  );
  const activeKinds = useMemo(() => {
    if (!chips.size) return null; // no filter → all
    const set = new Set<string>();
    FILTER_CHIPS.filter((c) => chips.has(c.key)).forEach((c) => c.kinds.forEach((k) => set.add(k)));
    return set;
  }, [chips]);

  // Errors drill-in support: the erroring tool_result rows + their paired
  // tool_use calls (same set OverviewMode's Errors KPI counts via
  // `messages.filter(isErrorResult)`), as a reference Set so `visible` below
  // can test membership in O(1) without re-deriving it per message.
  const errorRows = useMemo(() => (errorsOnly ? new Set(errorDrillIn(messages)) : null), [errorsOnly, messages]);

  const visible = useMemo(() => messages.filter((m) => {
    if (errorRows) {
      if (!errorRows.has(m)) return false;
    } else if (activeKinds && !activeKinds.has(m.kind)) return false;
    if (debounced) {
      const hay = `${m.text || ''} ${m.tool_name || ''} ${m.tool_input || ''}`.toLowerCase();
      if (!hay.includes(debounced)) return false;
    }
    return true;
  }), [messages, activeKinds, debounced, errorRows]);

  const selected = messages.find((m) => m.seq === selectedSeq) || null;

  // FR-TT-4: snapshot = nearest preceding commit for the selected message's
  // time. `commitLoading` is set synchronously the moment a NEW selection
  // starts a fetch and cleared only by the (non-stale) fetch that owns it —
  // gitAt/gitTree/gitFile each shell out to `git` synchronously
  // (server/git.ts execFileSync, blocking the whole Node event loop for the
  // subprocess's duration), so on a big/busy repo a snapshot fetch can take
  // a perceptible moment. Without this, the panel shows the PREVIOUS
  // snapshot with no indication a new one is even coming — indistinguishable
  // from "selecting a message doesn't drive the panel" (the reported P0).
  useEffect(() => {
    if (!data || !selected?.ts) return;
    let stale = false;
    setCommitLoading(true);
    api.gitAt(data.project.id, selected.ts).then((r: { noRepo?: boolean; commit?: CommitInfo | null }) => {
      if (stale) return;
      if (r.noRepo) { setNoRepo(true); setCommit(null); }
      else { setNoRepo(false); setCommit(r.commit ?? null); }
      setCommitLoading(false);
    }).catch(() => { if (!stale) setCommitLoading(false); });
    return () => { stale = true; };
  }, [data, selectedSeq]);

  // Cmd/Ctrl+F focuses search; Esc clears
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setMode('overview'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setMode('playback'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setMode('refine'); }
      // ⇧⌘U (⇧Ctrl+U) — Sync Update this session
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); syncRef.current?.(); }
      if (e.key === 'Escape') { setKeyword(''); searchRef.current?.blur(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function selectMessage(seq: number, scroll = false, fromTimeline = false): void {
    selectionFromTimelineRef.current = fromTimeline;
    setSelectedSeq(seq);
    if (scroll) {
      requestAnimationFrame(() => {
        listRef.current?.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  // Timeline seek: pick nearest visible message to a timestamp
  function seekTs(tsMillis: number): void {
    const pool = visible.length ? visible : messages;
    let best: PlaybackMessage | null = null, bestD = Infinity;
    for (const m of pool) {
      if (!m.ts) continue;
      const d = Math.abs(new Date(m.ts).getTime() - tsMillis);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) selectMessage(best.seq, true, true);
  }

  // Rename this session (optimistically patches the shared session object so the
  // breadcrumb, picker and overview title all update at once).
  async function renameSession(name: string): Promise<void> {
    const r = await api.renameSession(sessionId, name);
    setData((cur) => (cur ? { ...cur, session: { ...cur.session, name: r.name } } : cur));
  }

  // Per-session Sync Update: re-import just this session, then reload its messages.
  async function syncThisSession(): Promise<void> {
    if (syncingSession) return;
    setSyncErr(null);
    setSyncingSession(true);
    try {
      await api.syncSession(sessionId);
      setData(await api.sessionMessages(sessionId));
    } catch (e) {
      // Inline error (the native window.alert dialog no-ops in embedded/preview
      // browsers); a full-page error-banner would blow away the live session view.
      setSyncErr(String((e as Error).message));
    } finally {
      setSyncingSession(false);
    }
  }
  syncRef.current = syncThisSession;

  if (error) return <div className="page center error-banner">{error}</div>;
  if (!data) return <div className="page center muted">Loading session…</div>;

  return (
    <div className="session-view">
      <div className="session-main">
      <div className="session-toolbar">
        <div className="crumbs">
          <button className="crumb" title={`${data.project.name} — ${t('Project home page')}`} onClick={() => onBack(undefined, data.project.id)}>◫ {data.project.name}</button>
          <span className="crumb-sep">›</span>
          <SessionSwitcher projectId={data.project.id} current={{ ...data.session, message_count: messages.length, first_prompt: data.session.first_prompt }}
            onSwitch={onSwitchSession} />
        </div>
        {mode === 'playback' && <><div className="filter-chips">
          {errorsOnly ? (
            <button className="chip on" onClick={() => setErrorsOnly(false)}>{t('Errors')} ✕</button>
          ) : FILTER_CHIPS.map((c) => (
            <button key={c.key} className={`chip ${chips.has(c.key) ? 'on' : ''}`}
              onClick={() => setChips((prev) => {
                const next = new Set(prev);
                next.has(c.key) ? next.delete(c.key) : next.add(c.key);
                return next;
              })}>{c.label}</button>
          ))}
          {(chips.size > 0 || debounced || errorsOnly) && (
            <button className="chip clear" onClick={() => { setChips(new Set()); setKeyword(''); setErrorsOnly(false); }}>{t('Clear filter')}</button>
          )}
        </div>
        <input ref={searchRef} className="search" placeholder={t('Search messages…  ⌘F')}
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <span className="muted small">Match: <span className="num">{visible.length}/{messages.length}</span></span></>}
        <button className={`session-sync ${syncingSession ? 'spin' : ''}`}
          title={`${t('Sync this session')} (⇧⌘U)`} onClick={syncThisSession} disabled={syncingSession}
          aria-label={t('Sync this session')}>{syncingSession ? '◌' : '⟳'}</button>
        {syncErr && <span className="menu-err small">{syncErr}</span>}
      </div>

      {mode === 'playback' && <>
        {/* `gridTemplateColumns` is inline (not the static CSS default) so the
            chat column can be BOTH the drag-resized pixel width from
            `chatSplit` AND capped against the CURRENT viewport at all times —
            `min(${chatSplit.width}px, calc(100% - ${PLAYBACK_SPLIT_RESERVED}px))`
            re-evaluates on every browser layout (including a plain window
            resize, no drag needed), so a huge persisted width from a wider
            monitor — or the window simply shrinking — can never push the
            file-tree/code-view group below its own floor. See the
            PLAYBACK_SPLIT_RESERVED comment above for the 544 = handle(24) +
            file-tree(200) + code-view(320) breakdown. */}
        <div className="panes pb-grid" style={{
          gridTemplateColumns: `minmax(${PLAYBACK_SPLIT_MIN}px, min(${chatSplit.width}px, calc(100% - ${PLAYBACK_SPLIT_RESERVED}px))) 24px minmax(520px, 2.2fr)`,
        }}>
          <WindowedConvPane className="" paneRef={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              if (atBottomRef.current) setNewCount(0);
            }}
            header={newCount > 0 && (
              <button className="btn primary new-msgs" onClick={() => {
                if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                setNewCount(0);
              }}>↓ {newCount} new message{newCount > 1 ? 's' : ''}</button>
            )}
            messages={visible} selectedSeq={selectedSeq} keyword={debounced} causality={causality}
            onSelect={selectMessage} emptyText={t('No messages match the current filter.')} />
          <div className="pane-handle" role="separator" aria-orientation="vertical"
            aria-label={t('Resize chat / code panels')} tabIndex={0} title={t('Drag to resize · double-click to reset')}
            onPointerDown={chatSplit.onHandlePointerDown} onDoubleClick={chatSplit.reset} />
          <CodePanel projectId={data.project.id} commit={commit} noRepo={noRepo || !data.git?.isRepo} loading={commitLoading} />
        </div>
        <Timeline messages={messages} commits={data.commits}
          currentTs={selected?.ts} currentCommit={commit} onSeek={seekTs}
          selectionFromTimeline={selectionFromTimelineRef.current} />
      </>}

      {mode === 'overview' && (
        <OverviewMode data={data} messages={messages} liveStatus={liveStatus}
          onDeleted={(undo) => onBack(undo, data.project.id)} onRename={renameSession}
          onOpenSubagent={(a) => { setSubagentType(a); setSubagentRunId(null); setMode('subagent'); }}
          onOpenContent={() => setMode('content')}
          onOpenErrors={() => { setChips(new Set()); setKeyword(''); setErrorsOnly(true); setMode('playback'); }} />
      )}

      {mode === 'content' && (
        <div className="page">
          <button className="btn ghost small" style={{ marginBottom: 10 }} onClick={() => setMode('overview')}>
            ← {t('back to session')}
          </button>
          <ContentTab scope={{ type: 'session', id: sessionId }} days={null} />
        </div>
      )}

      {mode === 'subagent' && subagentType && !subagentRunId && (
        <div className="page">
          <div className="subagent-head">
            <button className="btn ghost small" onClick={() => { setSubagentType(null); setMode('overview'); }}>
              ← {t('back to session')}
            </button>
            <span className="subagent-title">
              <strong className="subagent-name">{t('Subagent runs')} · {subagentType}</strong>
              <span className="subagent-parent muted small" title={`${t('Parent session')} · ${sessionDisplayName(data.session)}`}>{t('Parent session')} · {sessionDisplayName(data.session)}</span>
            </span>
          </div>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('Start')}</th>
                  <th>{t('Duration')}</th>
                  <th>{t('Turns')}</th>
                  <th>{t('Tokens')}</th>
                  <th style={{ textAlign: 'left' }}>{t('Description')}</th>
                </tr>
              </thead>
              <tbody>
                {subagentRunRows.map((r) => {
                  const durMs = r.startTs && r.endTs ? new Date(r.endTs).getTime() - new Date(r.startTs).getTime() : null;
                  return (
                    <tr key={r.id} className="rowlink" role="button" tabIndex={0}
                      title={t('Open this run\'s transcript')}
                      onClick={() => setSubagentRunId(r.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSubagentRunId(r.id); } }}>
                      <td style={{ textAlign: 'left' }}>{r.startTs ? new Date(r.startTs).toLocaleString() : '—'}</td>
                      <td>{fmtDur(durMs)}</td>
                      <td>{r.turns}</td>
                      <td>{fmtTokNum(r.inputTokens + r.outputTokens)}</td>
                      <td className="t" style={{ textAlign: 'left' }} title={r.description || ''}>{r.description || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!subagentRunRows.length && <div className="muted small">{t('No runs found for this subagent type.')}</div>}
          </div>
        </div>
      )}

      {mode === 'subagent' && subagentType && subagentRunId && <>
        <div className="subagent-head">
          <button className="btn ghost small" onClick={() => setSubagentRunId(null)}>
            ← {t('back to run list')}
          </button>
          <span className="subagent-title">
            <strong className="subagent-name">{t('Subagent')} · {subagentType}</strong>
            <span className="subagent-parent muted small" title={`${t('Parent session')} · ${sessionDisplayName(data.session)}`}>{t('Parent session')} · {sessionDisplayName(data.session)}</span>
          </span>
        </div>
        <div className="panes">
          <WindowedConvPane className="subagent-conv" messages={subagentMessages} selectedSeq={selectedSeq}
            keyword="" causality={causality} onSelect={selectMessage}
            emptyText={t('No messages match the current filter.')} />
        </div>
      </>}

      {mode === 'refine' && (
        <RefineMode messages={messages} session={data.session} project={data.project} />
      )}

      {securityOpen && (
        <SecurityCheck sessionId={sessionId} projectName={data.project.name}
          onClose={() => setSecurityOpen(false)} />
      )}
      </div>
    </div>
  );
}

interface SessionSwitcherProps {
  projectId: number;
  current: Session & { message_count: number; first_prompt: string | null };
  onSwitch?: (sessionId: string) => void;
}

// Breadcrumb session dropdown: lazily loads the project's session list.
function SessionSwitcher({ projectId, current, onSwitch }: SessionSwitcherProps): JSX.Element {
  // GET /api/projects/:id returns the ProjectSessionSummary shape (per-session
  // summary rows), not full Session rows — use api.ts's canonical type instead
  // of forcing the local `Session` shape.
  const [sessions, setSessions] = useState<ProjectSessionSummary[] | null>(null);
  useEffect(() => {
    api.project(projectId).then((d: ProjectDetail) => setSessions(d.sessions)).catch(() => setSessions([]));
  }, [projectId]);
  return (
    <SessionPicker sessions={sessions || []} loading={sessions === null} current={current}
      onPick={(sid: string) => { if (sid !== current.id) onSwitch?.(sid); }} />
  );
}
