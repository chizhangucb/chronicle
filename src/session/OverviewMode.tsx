import React, { useMemo, useState, type JSX } from 'react';
import { ResponsiveContainer, AreaChart, CartesianGrid, XAxis, YAxis, Tooltip, Area } from 'recharts';
import { api } from '../api.js';
import { t } from '../i18n.js';
import InfoTip from '../InfoTip.tsx';
import { CATEGORICAL_COLORS } from '../colors.js';
import { AXIS_PROPS, GRID_PROPS, ChartTooltip } from '../charts/ChartWrapper.js';
import { contextWindowFor, costOf, costBreakdownOf, cacheWriteTokens, cacheWriteByTtl, cacheWriteCostByTtl } from '../models.js';
import { sessionDisplayName } from '../ProjectDetail.jsx';
import {
  FRIENDLY_CALL, DELETABLE_SOURCES, isErrorResult, isHumanPrompt, toolMixSorted, cumulativeCostSeries,
  fmtCtx, fmtTokNum, fmtDur, activeDurationMs, engagedDurationMs, summarizeToolInput, subagentRuns,
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
  // Drill into a subagent's transcript (see the Subagents card below). Optional
  // so other OverviewMode call sites (if any appear later) aren't forced to wire it.
  onOpenSubagent?: (agentType: string) => void;
  // Switch SessionView into the session-scoped Content panel (Task 5e-4's
  // "See what filled the context" link). Optional for the same reason as above.
  onOpenContent?: () => void;
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

interface FileTouched {
  path: string;
  count: number;
}

interface OverviewStats {
  errors: number;
  toolResultCount: number;
  promptCount: number;
  timeline: TimelineEntry[];
  filesTouched: FileTouched[];
  filesTouchedCount: number;
}

interface UsageRow {
  model: string;
  u: ModelUsage;
  cost: number | null;
  breakdown: CostBreakdown | null;
  cw: CacheWriteByTtl;
  cwCost: CacheWriteByTtl | null;
}

// Aggregate cost/token totals across every priced model's usage row — the
// SAME per-model loop feeds the KPI row, the chart grid (cost composition +
// cache behavior), and the token-usage table's totals row, computed once
// here rather than three times.
interface CostAgg {
  totalCost: number;
  modelCount: number;
  totalIn: number;
  totalOut: number;
  totalTokens: number;
  totalCacheRead: number;
  costInput: number;
  costOutput: number;
  cacheReadCost: number;
  cw5m: number;
  cw5mCost: number;
  cw1h: number;
  cw1hCost: number;
  cacheHitPct: number | null;
}

export default function OverviewMode({ data, messages, liveStatus, onDeleted, onRename, onOpenSubagent, onOpenContent }: OverviewModeProps): JSX.Element {
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
    const errors = messages.filter(isErrorResult).length;
    const toolResultCount = messages.filter((m) => m.kind === 'tool_result').length;
    const promptCount = messages.filter(isHumanPrompt).length;
    const timeline: TimelineEntry[] = messages
      .filter((m) => m.kind === 'user' || m.kind === 'tool_use')
      .slice(0, 12)
      .map((m) => ({
        seq: m.seq, ts: m.ts,
        label: m.kind === 'user' ? t('User Prompt') : (FRIENDLY_CALL[m.tool_name || ''] || m.tool_name || t('Tool')),
        preview: m.kind === 'user' ? (m.text || '').slice(0, 90) : summarizeToolInput(m.tool_name, m.tool_input).slice(0, 90),
      }));
    // Files touched: Edit/Write tool calls, tallied by file_path (same field
    // summarizeToolInput reads), sorted desc, top 10 shown — the card also
    // shows the total distinct-path count.
    const fileCounts = new Map<string, number>();
    for (const m of messages) {
      if (m.kind !== 'tool_use' || (m.tool_name !== 'Edit' && m.tool_name !== 'Write')) continue;
      try {
        const path: unknown = JSON.parse(m.tool_input || '{}').file_path;
        if (typeof path === 'string' && path) fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
      } catch { /* malformed tool_input — skip */ }
    }
    const filesTouched: FileTouched[] = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count }));
    return { errors, toolResultCount, promptCount, timeline, filesTouched, filesTouchedCount: fileCounts.size };
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

  // Context-window usage bar: real usage vs the model's window (static table).
  const model = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].model) return messages[i].model as string;
    return null;
  }, [messages]);
  const ctxWindow: number | null = contextWindowFor(model);
  const ctxPct = ctxWindow && session.context_tokens && session.context_tokens > 0
    ? (session.context_tokens / ctxWindow) * 100 : null;
  const ctxPctRounded = ctxPct === null ? null : Math.round(ctxPct);
  const ctxLevel = ctxPct === null ? null
    : ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'high' : ctxPct >= 50 ? 'mid' : 'low';

  // Cost & Usage: per-model token totals from the parser + list-price cost estimate.
  // `usageByModel` is the single parsed source both the per-model rows AND the
  // cost-over-session series (which needs it keyed by model) are built from.
  const usageByModel = useMemo<Record<string, ModelUsage>>(() => {
    try { return session.usage ? JSON.parse(session.usage) : {}; } catch { return {}; }
  }, [session.usage]);
  const usageRows: UsageRow[] = useMemo(() => {
    return Object.entries(usageByModel)
      // Drop token-less models (e.g. Claude Code's "<synthetic>" placeholder).
      .filter(([, u]) => (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + cacheWriteTokens(u) > 0)
      .map(([m, u]) => ({ model: m, u, cost: costOf(m, u), breakdown: costBreakdownOf(m, u),
        cw: cacheWriteByTtl(u), cwCost: cacheWriteCostByTtl(m, u) }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  }, [usageByModel]);

  // Hoisted once, reused by the KPI row, the chart grid, and the token table's
  // totals row — NOT recomputed per section.
  const costAgg: CostAgg = useMemo(() => {
    let totalCost = 0, totalIn = 0, totalOut = 0, totalCacheRead = 0;
    let costInput = 0, costOutput = 0, cacheReadCost = 0, cw5m = 0, cw5mCost = 0, cw1h = 0, cw1hCost = 0;
    for (const r of usageRows) {
      totalIn += r.u.input || 0;
      totalOut += r.u.output || 0;
      totalCacheRead += r.u.cacheRead || 0;
      if (r.cost != null) totalCost += r.cost;
      if (r.breakdown) {
        costInput += r.breakdown.input;
        costOutput += r.breakdown.output;
        cacheReadCost += r.breakdown.cacheRead;
      }
      cw5m += r.cw.cw5m;
      cw1h += r.cw.cw1h;
      if (r.cwCost) {
        cw5mCost += r.cwCost.cw5m;
        cw1hCost += r.cwCost.cw1h;
      }
    }
    const cacheHitPct = (totalCacheRead + totalIn) > 0
      ? Math.round((totalCacheRead / (totalCacheRead + totalIn)) * 100) : null;
    return {
      totalCost, modelCount: usageRows.length, totalIn, totalOut, totalTokens: totalIn + totalOut,
      totalCacheRead, costInput, costOutput, cacheReadCost, cw5m, cw5mCost, cw1h, cw1hCost, cacheHitPct,
    };
  }, [usageRows]);

  // Subagents card: sourced from the UNFILTERED session messages — `messages`
  // (this component's prop) already has sidechain rows stripped out by
  // SessionView, but subagent turns ARE sidechain rows, so the raw
  // `data.messages` is the only place they still exist.
  const subagents = useMemo(() => subagentRuns(data.messages), [data.messages]);

  const costSeries = useMemo(() => cumulativeCostSeries(messages, usageByModel), [messages, usageByModel]);
  const toolMix = useMemo(() => toolMixSorted(messages), [messages]);
  const maxToolCount = toolMix[0]?.count ?? 1;
  const msgCountByModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) {
      if (msg.kind === 'assistant' && msg.model) m.set(msg.model, (m.get(msg.model) ?? 0) + 1);
    }
    return m;
  }, [messages]);

  const errorPct = stats.toolResultCount > 0 ? Math.round((stats.errors / stats.toolResultCount) * 100) : 0;

  const compSegments = [
    { key: 'output', label: t('output'), value: costAgg.costOutput, color: CATEGORICAL_COLORS[0] },
    { key: 'cw5m', label: t('cache write 5m'), value: costAgg.cw5mCost, color: CATEGORICAL_COLORS[1] },
    { key: 'cw1h', label: t('cache write 1h'), value: costAgg.cw1hCost, color: CATEGORICAL_COLORS[2] },
    { key: 'cacheRead', label: t('cache read'), value: costAgg.cacheReadCost, color: CATEGORICAL_COLORS[3] },
    { key: 'input', label: t('input'), value: costAgg.costInput, color: CATEGORICAL_COLORS[4] },
  ].filter((s) => s.value > 0);

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

      <div className="kpis">
        <div className="kpi"><div className="l">{t('Cost')}</div><div className="v">${costAgg.totalCost.toFixed(2)}</div><div className="s">{costAgg.modelCount} {t('models')}</div></div>
        <div className="kpi"><div className="l">{t('Tokens')}</div><div className="v">{fmtTokNum(costAgg.totalTokens)}</div><div className="s">{fmtTokNum(costAgg.totalIn)} {t('in')} · {fmtTokNum(costAgg.totalOut)} {t('out')}</div></div>
        <div className="kpi"><div className="l">{t('Agent active')} <InfoTip text={t('How long the agent was actively working, subagent activity included. Tool execution time (a tool result following its tool call) counts in full — a long build or test run shows up. Every other gap is capped at 10 minutes, and the pause before each of your real prompts is excluded entirely (your reading/typing/away time). Total Duration, by contrast, is the full wall-clock span from the first message to the last.')} /></div>
          <div className="v">{fmtDur(activeMs)}</div><div className="s">{t('of')} {dur} {t('total')}</div></div>
        <div className="kpi"><div className="l">{t('Engaged')} <InfoTip text={t('Engaged time approximates how long you were hands-on with this session: the sum of every gap between consecutive messages, each capped at 90 minutes. Unlike Agent Active, it makes no distinction between agent work and your own pauses — it is closer to the wall-clock time the session was in use.')} /></div>
          <div className="v">{fmtDur(engagedMs)}</div><div className="s">{t('your attention')}</div></div>
        <div className="kpi"><div className="l">{t('Messages')}</div><div className="v">{messages.length}</div><div className="s">{stats.promptCount} {t('prompts')}</div></div>
        <div className={`kpi ${stats.errors > 0 ? 'warn' : ''}`}><div className="l">{t('Errors')}</div><div className="v">{stats.errors}</div><div className="s">{errorPct}% {t('of results')}</div></div>
        {ctxPctRounded !== null && (
          <div className="kpi"><div className="l">{t('Peak context')}</div><div className="v">{ctxPctRounded}%</div><div className="s">{fmtCtx(ctxWindow || 0)} {t('window')}</div></div>
        )}
        {costAgg.cacheHitPct !== null && (
          <div className="kpi"><div className="l">{t('Cache hit')}</div><div className="v">{costAgg.cacheHitPct}%</div><div className="s">{t('read / (read+in)')}</div></div>
        )}
      </div>

      {onOpenContent && (
        <button type="button" className="ov-content-link" onClick={onOpenContent}>
          {t('See what filled the context →')}
        </button>
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

      <div className="grid">
        <div className="card">
          <h3>{t('Cost over session')}</h3>
          {costAgg.totalCost > 0 ? (
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={costSeries}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="t" {...AXIS_PROPS} tickFormatter={(v: string) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
                <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip content={(props) => {
                  // Recharts' <Tooltip> content callback is fixed to its own
                  // (wider) ValueType/NameType — not generic per call site —
                  // so it doesn't structurally match ChartWrapper's narrower
                  // `ChartTooltipProps<number>`; this data is always numeric
                  // in practice (see cumulativeCostSeries), so the cast is safe.
                  // `labelFormatter` only affects Recharts' OWN default content
                  // renderer — it's silently ignored once a custom `content` is
                  // supplied, so the ISO timestamp is reformatted here instead.
                  const p = props as Parameters<typeof ChartTooltip>[0];
                  const label = p.label != null
                    ? new Date(String(p.label)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : p.label;
                  return <ChartTooltip {...p} label={label} formatValue={(v) => `$${v.toFixed(2)}`} />;
                }} />
                <Area type="stepAfter" dataKey="cumCost" name={t('Cost')} stroke={CATEGORICAL_COLORS[0]} fill={CATEGORICAL_COLORS[0]} fillOpacity={0.12} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="muted small">{t('No cost data for this session.')}</div>
          )}
        </div>

        <div className="card">
          <h3>{t('Tool mix')}</h3>
          {toolMix.length > 0 ? toolMix.slice(0, 6).map((row, i) => (
            <div className="hbar" key={row.name}><span className="n">{FRIENDLY_CALL[row.name] ?? row.name}</span>
              <div className="track"><div className="fill" style={{ width: `${(row.count / maxToolCount) * 100}%`, background: CATEGORICAL_COLORS[i % 5] }} /></div>
              <span className="v num">{row.count}</span></div>
          )) : <div className="muted small">{t('No tool calls recorded.')}</div>}
        </div>

        <div className="card">
          <h3>{t('Cost composition')}{costAgg.totalCost > 0 ? ` · $${costAgg.totalCost.toFixed(2)}` : ''}</h3>
          {costAgg.totalCost > 0 ? (
            <>
              <div className="comp-bar">
                {compSegments.map((s) => (
                  <span key={s.key} style={{ width: `${(s.value / costAgg.totalCost) * 100}%`, background: s.color }} />
                ))}
              </div>
              <div className="comp-legend">
                {compSegments.map((s) => (
                  <span key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label} ${s.value.toFixed(2)}</span>
                ))}
              </div>
              <h3 style={{ marginTop: 12 }}>{t('Cache behavior')}</h3>
              <div className="cost-row"><span>{t('read')}</span><b className="num">{fmtTokNum(costAgg.totalCacheRead)} · ${costAgg.cacheReadCost.toFixed(2)}</b></div>
              <div className="cost-row"><span>{t('write')} <span className="ttl">5m</span></span><b className="num">{fmtTokNum(costAgg.cw5m)} · ${costAgg.cw5mCost.toFixed(2)}</b></div>
              {costAgg.cw1h > 0 && (
                <div className="cost-row"><span>{t('write')} <span className="ttl">1h</span></span><b className="num">{fmtTokNum(costAgg.cw1h)} · ${costAgg.cw1hCost.toFixed(2)}</b></div>
              )}
            </>
          ) : (
            <div className="muted small">{t('No cost data for this session.')}</div>
          )}
        </div>
      </div>

      {usageRows.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>{t('Token usage by model')}</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('Model')}</th>
                <th>{t('Input')}</th>
                <th>{t('Output')}</th>
                <th>{t('Cache read')}</th>
                <th title={t('5-minute TTL cache write')}>{t('Cache write 5m')}</th>
                <th title={t('1-hour TTL cache write')}>{t('Cache write 1h')}</th>
                <th>{t('Hit rate')} <InfoTip text={t('Cache read ÷ (cache read + input): the share of prompt-side tokens served from cache instead of re-sent at full input price. Higher = cheaper turns.')} /></th>
                <th>{t('Msgs')}</th>
                <th>{t('Cost')}</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map((r, i) => {
                const rHit = (r.u.cacheRead || 0) + (r.u.input || 0) > 0
                  ? Math.round(((r.u.cacheRead || 0) / ((r.u.cacheRead || 0) + (r.u.input || 0))) * 100) : null;
                return (
                  <tr key={r.model}>
                    <td><span className="dot" style={{ background: CATEGORICAL_COLORS[i % 5] }} />{r.model}</td>
                    <td>{fmtTokNum(r.u.input)}</td>
                    <td>{fmtTokNum(r.u.output)}</td>
                    <td>{fmtTokNum(r.u.cacheRead)}</td>
                    <td>{fmtTokNum(r.cw.cw5m)}</td>
                    <td>{r.cw.cw1h > 0 ? fmtTokNum(r.cw.cw1h) : '—'}</td>
                    <td>{rHit !== null ? `${rHit}%` : '—'}</td>
                    <td>{msgCountByModel.get(r.model) ?? 0}</td>
                    <td className="cost">{r.cost != null ? `$${r.cost.toFixed(2)}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>{t('Session total')}</td>
                <td>{fmtTokNum(costAgg.totalIn)}</td>
                <td>{fmtTokNum(costAgg.totalOut)}</td>
                <td>{fmtTokNum(costAgg.totalCacheRead)}</td>
                <td>{fmtTokNum(costAgg.cw5m)}</td>
                <td>{costAgg.cw1h > 0 ? fmtTokNum(costAgg.cw1h) : '—'}</td>
                <td>{costAgg.cacheHitPct !== null ? `${costAgg.cacheHitPct}%` : '—'}</td>
                <td>{[...msgCountByModel.values()].reduce((a, b) => a + b, 0)}</td>
                <td className="cost">${costAgg.totalCost.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
          <div className="muted small" style={{ marginTop: 6 }}>{t('Estimated from token counts × current list prices')}</div>
        </div>
      )}

      <div className="two">
        <div className="card">
          <h3>{t('Conversation timeline')}</h3>
          {stats.timeline.map((e) => (
            <div key={e.seq} className="trow">
              <span className="k num">{e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              <span className="t">{e.label}{e.preview ? ` — ${e.preview}` : ''}</span>
            </div>
          ))}
          {!stats.timeline.length && <div className="muted small">{t('No tool calls recorded.')}</div>}
        </div>

        <div className="card">
          <h3>{t('Files touched')} · {stats.filesTouchedCount}</h3>
          {stats.filesTouched.map((f) => (
            <div key={f.path} className="trow">
              <span className="k num">{f.count}Δ</span>
              <span className="t">{f.path}</span>
            </div>
          ))}
          {!stats.filesTouched.length && <div className="muted small">{t('No files touched.')}</div>}
        </div>

        {subagents.length > 0 && (
          <div className="card">
            <h3>{t('Subagents')} · {subagents.length}</h3>
            {subagents.map((r) => (
              <div key={r.agentType} className="trow subagent-row"
                role="button" tabIndex={0}
                onClick={() => onOpenSubagent?.(r.agentType)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSubagent?.(r.agentType); } }}>
                <span className="t">{r.agentType}</span>
                <span className="k num">×{r.turns}</span>
                <b className="num">{fmtTokNum(r.inputTokens + r.outputTokens)}</b>
                <span className="subagent-arrow">→</span>
              </div>
            ))}
          </div>
        )}
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
