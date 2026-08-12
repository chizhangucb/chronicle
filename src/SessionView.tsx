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
import ContentTab from './ContentTab.tsx';
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
  const [commit, setCommit] = useState<CommitInfo | null>(null);
  const [noRepo, setNoRepo] = useState(false);
  const [mode, setMode] = useState<SessionMode>('overview');
  // Which subagent's transcript the 'subagent' drill-in mode is showing (set by
  // OverviewMode's Subagents card; null when not drilled in). NOT part of the
  // sidebar rail's `modes` — it's a drill-in reached only via the Overview card.
  const [subagentRun, setSubagentRun] = useState<string | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [causality, setCausality] = useState<CausalityData | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('off');
  const [newCount, setNewCount] = useState(0);
  const [syncingSession, setSyncingSession] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const atBottomRef = useRef(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const syncRef = useRef<(() => void) | null>(null); // always points at the latest syncThisSession (for the ⇧⌘U shortcut)

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
  // 'subagent' drill-in: that agent type's sidechain transcript, read from the
  // UNFILTERED session messages (sidechains are excluded from `messages` above).
  const subagentMessages = useMemo(
    () => (data?.messages ?? []).filter((m) => m.is_sidechain && m.agent_type === subagentRun),
    [data, subagentRun],
  );
  const activeKinds = useMemo(() => {
    if (!chips.size) return null; // no filter → all
    const set = new Set<string>();
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
    api.gitAt(data.project.id, selected.ts).then((r: { noRepo?: boolean; commit?: CommitInfo | null }) => {
      if (stale) return;
      if (r.noRepo) { setNoRepo(true); setCommit(null); }
      else { setNoRepo(false); setCommit(r.commit ?? null); }
    }).catch(() => {});
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

  function selectMessage(seq: number, scroll = false): void {
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
    if (best) selectMessage(best.seq, true);
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
          <button className="crumb" title={t('Project home page')} onClick={() => onBack(undefined, data.project.id)}>◫ {data.project.name}</button>
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
        <span className="muted small">Match: <span className="num">{visible.length}/{messages.length}</span></span></>}
        <button className={`session-sync ${syncingSession ? 'spin' : ''}`}
          title={`${t('Sync this session')} (⇧⌘U)`} onClick={syncThisSession} disabled={syncingSession}
          aria-label={t('Sync this session')}>{syncingSession ? '◌' : '⟳'}</button>
        {syncErr && <span className="menu-err small">{syncErr}</span>}
      </div>

      {mode === 'playback' && <>
        <div className="panes">
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
          <CodePanel projectId={data.project.id} commit={commit} noRepo={noRepo || !data.git?.isRepo} />
        </div>
        <Timeline messages={messages} commits={data.commits}
          currentTs={selected?.ts} currentCommit={commit} onSeek={seekTs} />
      </>}

      {mode === 'overview' && (
        <OverviewMode data={data} messages={messages} liveStatus={liveStatus}
          onDeleted={(undo) => onBack(undo, data.project.id)} onRename={renameSession}
          onOpenSubagent={(a) => { setSubagentRun(a); setMode('subagent'); }}
          onOpenContent={() => setMode('content')} />
      )}

      {mode === 'content' && (
        <div className="page">
          <button className="btn ghost small" style={{ marginBottom: 10 }} onClick={() => setMode('overview')}>
            ← {t('back to session')}
          </button>
          <ContentTab scope={{ type: 'session', id: sessionId }} days={null} />
        </div>
      )}

      {mode === 'subagent' && subagentRun && <>
        <div className="subagent-head">
          <button className="btn ghost small" onClick={() => { setSubagentRun(null); setMode('overview'); }}>
            ← {t('back to session')}
          </button>
          <span className="subagent-title">
            <strong className="subagent-name">{t('Subagent')} · {subagentRun}</strong>
            <span className="subagent-parent muted small">{t('Parent session')} · {sessionDisplayName(data.session)}</span>
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
