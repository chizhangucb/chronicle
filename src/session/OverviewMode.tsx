import React, { useMemo, useState, type JSX } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.js';
import InfoTip from '../InfoTip.tsx';
import { contextWindowFor, costOf, costBreakdownOf, cacheWriteTokens, cacheWriteByTtl, cacheWriteCostByTtl } from '../models.js';
import { sessionDisplayName } from '../ProjectDetail.jsx';
import {
  FRIENDLY_CALL, DONUT_COLORS, DELETABLE_SOURCES, isErrorResult, topDist,
  fmtCtx, fmtTokNum, fmtDur, activeDurationMs, engagedDurationMs, summarizeToolInput,
} from './stats.js';
import type { PlaybackMessage } from './MessageRow.tsx';
import type { Session, SessionData, LiveStatus } from '../SessionView.tsx';
import type { ModelUsage } from '@shared/types.ts';
import type { DeletedEntry } from '../SessionSelect.tsx';

// Cost & Usage math lives in ../models.js (still untyped JS — see the task
// report for the shared-type gap this stands in for). These mirror its actual
// return shapes so callers here stay honest rather than falling back to `any`.
interface CostBreakdown { input: number; output: number; cacheWrite: number; cacheRead: number; }
interface CacheWriteByTtl { cw5m: number; cw1h: number; }

export interface OverviewModeProps {
  data: SessionData;
  messages: PlaybackMessage[];
  liveStatus: LiveStatus;
  // Passes the deleted session's undo payload (same shape the multi-select
  // flow uses) so the destination view can surface the SHARED undo toast —
  // an Overview delete navigates away immediately, so it can't show its own.
  onDeleted: (undo?: DeletedEntry) => void;
  onRename: (name: string) => Promise<void>;
}

// Donut + legend card shared by the Tool / Skill / MCP distributions.
function DistributionCard({ title, entries, emptyLabel }: { title: string; entries: [string, number][]; emptyLabel: string }): JSX.Element {
  const total = entries.reduce((s, [, n]) => s + n, 0);
  let acc = 0;
  const gradient = entries.map(([, n], i) => {
    const from = (acc / Math.max(1, total)) * 360; acc += n;
    const to = (acc / Math.max(1, total)) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${to}deg`;
  }).join(', ');
  return (
    <div className="card ov-block">
      <div className="ov-block-head"><strong>{title}</strong></div>
      <div className="ov-donut-wrap">
        {total > 0 && <div className="ov-donut" style={{ background: `conic-gradient(${gradient})` }} />}
        <div>
          {entries.map(([name, n], i) => (
            <div key={name} className="ov-legend-row">
              <span className="ov-legend-dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="ov-legend-name" title={name}>{name}</span>
              <span className="muted small">{Math.round((n / Math.max(1, total)) * 100)}%</span>
            </div>
          ))}
          {!total && <div className="muted small">{emptyLabel}</div>}
          <div className="muted small" style={{ marginTop: 6 }}>{t('Total')} {total} {t('calls')}</div>
        </div>
      </div>
    </div>
  );
}

// Session ID with one-click copy (shown on the session home page).
function SessionIdChip({ id }: { id: string }): JSX.Element {
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

interface TimelineEntry {
  seq: number;
  ts: string | null | undefined;
  label: string;
  preview: string;
}

interface OverviewStats {
  toolUses: PlaybackMessage[];
  errors: number;
  errorIds: Set<string>;
  top: [string, number][];
  timeline: TimelineEntry[];
  skillTop: [string, number][];
  mcpTop: [string, number][];
}

interface UsageRow {
  model: string;
  u: ModelUsage;
  cost: number | null;
  breakdown: CostBreakdown | null;
  cw: CacheWriteByTtl;
  cwCost: CacheWriteByTtl | null;
}

export default function OverviewMode({ data, messages, liveStatus, onDeleted, onRename }: OverviewModeProps): JSX.Element {
  const { session } = data;

  // Inline rename (edit-in-place). Avoids window.prompt(), which is blocked in
  // embedded/preview browser contexts and would fail silently.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  function startRename() { setDraft(session.name || ''); setEditing(true); }
  async function saveRename() {
    if (savingName) return;
    setSavingName(true);
    try { await onRename?.(draft); setEditing(false); }
    catch (e) { alert(String((e as Error).message)); }
    finally { setSavingName(false); }
  }

  const stats: OverviewStats = useMemo(() => {
    const toolUses = messages.filter((m) => m.kind === 'tool_use');
    const errorIds = new Set(messages.filter(isErrorResult).map((m) => m.tool_use_id).filter((id): id is string => Boolean(id)));
    const errors = messages.filter(isErrorResult).length;
    const dist = new Map<string, number>();
    for (const m of toolUses) dist.set(m.tool_name || 'unknown', (dist.get(m.tool_name || 'unknown') || 0) + 1);
    const distSorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
    const top = distSorted.slice(0, 7);
    const otherCount = distSorted.slice(7).reduce((s, [, n]) => s + n, 0);
    if (otherCount) top.push(['other', otherCount]);
    const timeline: TimelineEntry[] = messages
      .filter((m) => m.kind === 'user' || m.kind === 'tool_use')
      .slice(0, 12)
      .map((m) => ({
        seq: m.seq, ts: m.ts,
        label: m.kind === 'user' ? 'User Prompt' : (FRIENDLY_CALL[m.tool_name || ''] || m.tool_name || 'Tool'),
        preview: m.kind === 'user' ? (m.text || '').slice(0, 90) : summarizeToolInput(m.tool_name, m.tool_input).slice(0, 90),
      }));
    // Skill usage (Skill tool → tool_input.skill) and MCP usage (mcp__<server>__<tool>
    // grouped by server) — same top-7 + "other" shape as the tool distribution.
    const skillTop = topDist(toolUses
      .filter((m) => m.tool_name === 'Skill')
      .map((m) => { try { return JSON.parse(m.tool_input || '{}').skill || 'skill'; } catch { return 'skill'; } }));
    const mcpTop = topDist(toolUses
      .filter((m) => (m.tool_name || '').startsWith('mcp__'))
      .map((m) => (m.tool_name as string).split('__')[1] || 'mcp'));
    return { toolUses, errors, errorIds, top, timeline, skillTop, mcpTop };
  }, [messages]);

  const durationMs = session.started_at && session.ended_at
    ? new Date(session.ended_at).getTime() - new Date(session.started_at).getTime() : null;
  const dur = durationMs === null ? '—' : fmtDur(durationMs);
  // Stored at import since v0.2 (sidechains included); client fallback for
  // older imports and live-only sessions.
  const fallbackActiveMs = useMemo(() => activeDurationMs(data.messages), [data.messages]);
  const fallbackEngagedMs = useMemo(() => engagedDurationMs(data.messages), [data.messages]);
  const activeMs = session.agent_active_ms ?? fallbackActiveMs;
  const engagedMs = session.engaged_ms ?? fallbackEngagedMs;

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
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].model) return messages[i].model as string;
    return null;
  }, [messages]);
  const ctxWindow: number | null = contextWindowFor(model);
  const ctxPct = ctxWindow && session.context_tokens && session.context_tokens > 0
    ? (session.context_tokens / ctxWindow) * 100 : null;
  const ctxLevel = ctxPct === null ? null
    : ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'high' : ctxPct >= 50 ? 'mid' : 'low';

  // Cost & Usage: per-model token totals from the parser + list-price cost estimate.
  const usageRows: UsageRow[] = useMemo(() => {
    let usage: Record<string, ModelUsage> | null;
    try { usage = session.usage ? JSON.parse(session.usage) : null; } catch { usage = null; }
    if (!usage) return [];
    return Object.entries(usage)
      // Drop token-less models (e.g. Claude Code's "<synthetic>" placeholder).
      .filter(([, u]) => (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + cacheWriteTokens(u) > 0)
      .map(([m, u]) => ({ model: m, u, cost: costOf(m, u), breakdown: costBreakdownOf(m, u),
        cw: cacheWriteByTtl(u), cwCost: cacheWriteCostByTtl(m, u) }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  }, [session.usage]);
  const totalCost = useMemo(() => {
    const priced = usageRows.filter((r) => r.cost != null);
    return priced.length ? priced.reduce((s, r) => s + (r.cost as number), 0) : null;
  }, [usageRows]);

  return (
    <div className="page overview-page">
      <div className="ov-name-row">
        {editing ? (
          <>
            <span className="ov-title-icon">📊</span>
            <input className="ov-name-input" autoFocus value={draft} disabled={savingName}
              placeholder={sessionDisplayName(session)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setEditing(false); }} />
            <button className="btn tiny primary" disabled={savingName} onMouseDown={(e) => e.preventDefault()} onClick={saveRename}>✓</button>
            <button className="btn tiny ghost" disabled={savingName} onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(false)}>✕</button>
            {session.name && <span className="muted small">{t('Leave blank to reset to default')}</span>}
          </>
        ) : (
          <>
            <h3 className="ov-title">📊 {sessionDisplayName(session)}</h3>
            <button className="btn tiny ghost" title={t('Rename session')} onClick={startRename}>✎</button>
          </>
        )}
      </div>
      <div className="ov-title-row">
        <span className="muted small">{t('Session Statistics')}{session.started_at ? ` — ${new Date(session.started_at).toLocaleString()}` : ''}</span>
        <SessionIdChip id={session.id} />
      </div>
      <div className="analytics-row">
        <div className="card stat" title={t('Wall-clock span from the first message to the last')}>
          <div className="stat-num">{dur}</div><div className="muted small">{t('Total Duration')}</div></div>
        <div className="card stat">
          <div className="stat-num">{fmtDur(activeMs)}</div>
          <div className="muted small">{t('Agent Active')} <InfoTip text={t('How long the agent was actively working, subagent activity included. Tool execution time (a tool result following its tool call) counts in full — a long build or test run shows up. Every other gap is capped at 10 minutes, and the pause before each of your real prompts is excluded entirely (your reading/typing/away time). Total Duration, by contrast, is the full wall-clock span from the first message to the last.')} /></div>
          <div className="muted small">{t('Engaged')} {fmtDur(engagedMs)} <InfoTip text={t('Engaged time approximates how long you were hands-on with this session: the sum of every gap between consecutive messages, each capped at 90 minutes. Unlike Agent Active, it makes no distinction between agent work and your own pauses — it is closer to the wall-clock time the session was in use.')} /></div>
        </div>
        <div className="card stat"><div className="stat-num">{messages.length}</div><div className="muted small">{t('Messages')}</div></div>
        <div className="card stat"><div className="stat-num">{totalCalls}</div><div className="muted small">{t('Tool Calls')}</div></div>
        <div className="card stat"><div className={`stat-num ${stats.errors ? 'bad' : ''}`}>{stats.errors}</div><div className="muted small">{t('Errors')}</div></div>
        {session.context_tokens != null && session.context_tokens > 0 && (
          <div className="card stat" title={t('Context window size at the last message (real usage from the session log)')}>
            <div className="stat-num">{session.context_tokens >= 1e6 ? `${(session.context_tokens / 1e6).toFixed(1)}M` : `${Math.round(session.context_tokens / 1000)}k`}</div>
            <div className="muted small">{t('Context')}</div>
          </div>
        )}
      </div>

      {usageRows.length > 0 && (
        <div className="card ov-block cost-block">
          <div className="ov-block-head">
            <strong>{t('Cost & Usage')}</strong>
            <span className="cost-total">{totalCost != null ? `$${totalCost.toFixed(2)}` : '—'}</span>
          </div>
          <div className="cost-models">
            {usageRows.map((r) => (
              <div key={r.model} className="cost-model-row">
                <div className="cost-model-head">
                  <span className="mono-path small">{r.model}</span>
                  <span className="cost-model-cost">{r.cost != null ? `$${r.cost.toFixed(2)}` : '—'}</span>
                </div>
                <div className="cost-tokens muted small">
                  <span><em>{t('Input')}</em> {fmtTokNum(r.u.input)}</span>
                  <span><em>{t('Output')}</em> {fmtTokNum(r.u.output)}</span>
                  <span><em>{t('Cache Read')}</em> {fmtTokNum(r.u.cacheRead)}</span>
                  <span title={t('5-minute TTL cache write')}>
                    <em>{t('Cache Write')} <span className="ttl-tag">5m</span></em> {fmtTokNum(r.cw.cw5m)}</span>
                  {r.cw.cw1h > 0 && (
                    <span title={t('1-hour TTL cache write')}>
                      <em>{t('Cache Write')} <span className="ttl-tag">1h</span></em> {fmtTokNum(r.cw.cw1h)}</span>
                  )}
                </div>
                {r.breakdown && (
                  <div className="cost-tokens cost-dollars muted small">
                    <span><em>{t('Input')}</em> ${r.breakdown.input.toFixed(2)}</span>
                    <span><em>{t('Output')}</em> ${r.breakdown.output.toFixed(2)}</span>
                    <span><em>{t('Cache Read')}</em> ${r.breakdown.cacheRead.toFixed(2)}</span>
                    <span title={t('5-minute TTL cache write')}>
                      <em>{t('Cache Write')} <span className="ttl-tag">5m</span></em> ${(r.cwCost?.cw5m ?? 0).toFixed(2)}</span>
                    {r.cw.cw1h > 0 && (
                      <span title={t('1-hour TTL cache write')}>
                        <em>{t('Cache Write')} <span className="ttl-tag">1h</span></em> ${(r.cwCost?.cw1h ?? 0).toFixed(2)}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="muted small">{t('Estimated from token counts × current list prices')}</div>
        </div>
      )}

      {ctxPct !== null && (
        <div className="card ov-block ctx-block">
          <div className="ctx-head">
            <strong>{t('Context Window')}</strong>
            <span className="muted small">{model}</span>
            <span className={`ctx-pct ${ctxLevel}`}>
              {fmtCtx(session.context_tokens || 0)} / {fmtCtx(ctxWindow || 0)} · {Math.round(ctxPct)}%
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
                <span className={m.tool_use_id && stats.errorIds.has(m.tool_use_id) ? 'bad' : 'ok'}>{m.tool_use_id && stats.errorIds.has(m.tool_use_id) ? '✗' : '✓'}</span>
                <span className="ov-tl-label">{FRIENDLY_CALL[m.tool_name || ''] || m.tool_name || 'Tool'}</span>
                <span className="muted small ov-tl-preview">{summarizeToolInput(m.tool_name, m.tool_input).slice(0, 100) || '-'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="ov-cols">
        <DistributionCard title={t('Skill Distribution')} entries={stats.skillTop} emptyLabel={t('No skills used.')} />
        <DistributionCard title={t('MCP Distribution')} entries={stats.mcpTop} emptyLabel={t('No MCP tools used.')} />
      </div>

      <SourceFileZone session={session} liveStatus={liveStatus} onDeleted={onDeleted} />
    </div>
  );
}

interface SourceFileZoneProps {
  session: Session;
  liveStatus: LiveStatus;
  onDeleted: (undo?: DeletedEntry) => void;
}

type ConfirmKind = 'file' | 'everywhere' | 'chronicle';

// Danger zone: delete the original log file, the Chronicle copy, or both.
// Every action is a two-step inline confirm; deletion is permanent (no backup).
function SourceFileZone({ session, liveStatus, onDeleted }: SourceFileZoneProps): JSX.Element {
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileDeleted, setFileDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletable = DELETABLE_SOURCES.has(session.source);
  const live = liveStatus === 'live' || liveStatus === 'reconnecting';

  const CONFIRM_TEXT: Record<ConfirmKind, string> = {
    file: t('Permanently delete the original log file from disk? This cannot be undone. The imported copy stays in Chronicle.'),
    everywhere: t('Permanently delete the original log file AND the imported copy in Chronicle? This cannot be undone.'),
    chronicle: t('Delete the imported copy from Chronicle? The original log stays on disk and can be re-imported later.'),
  };

  async function run(action: ConfirmKind) {
    setBusy(true);
    setError(null);
    try {
      if (action === 'file') {
        await api.deleteSessionSource(session.id);
        setFileDeleted(true);
        setConfirming(null);
      } else {
        const r = await api.deleteSession(session.id, action === 'everywhere');
        // session no longer exists — back to the project page, carrying the
        // undo payload so the destination can surface the shared undo toast.
        onDeleted({ id: session.id, source: r.source, projectId: r.projectId });
      }
    } catch (e) { setError(String((e as Error).message)); }
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
