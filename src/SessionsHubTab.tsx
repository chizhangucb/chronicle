import React, { useMemo, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import type { InsightsResult, InsightsSessionRow } from './api.js';
import { useCostMode } from './costMode.tsx';
import { groupByKey, costOfBucketedCells, tokensOfCells, sumByKeyModel } from './windowedUsage.ts';
import { fmtMoney, fmtInt } from './format.js';
import { t, lang } from './i18n.js';
import InfoTip from './InfoTip.tsx';
import SortCaret from './SortCaret.tsx';
import type { RangeKey } from './RangeBar.tsx';
import { sessionDisplayName } from './ProjectDetail.jsx';
import { formatRelativeTime } from './relativeTime.js';
import { fmtDayLabel, dayKeyOf } from './charts/timeBuckets.ts';
import { CATEGORICAL_COLORS, projectColorMap } from './colors.ts';

// The Sessions tab (CHI-324 2g): the ANALYZE half of the two session lists
// (the /projects ledger is the MANAGE half). Header count + [human|all] toggle →
// three-up aggregates (busiest days · busiest projects · automation by job) →
// ONE flat sessions table (chips cost|duration|recent, cost default), click-to-
// extend. All spend is priced client-side from the windowed cells.

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
function localeOf(): string { return INTL_LOCALE[lang()] ?? 'en-US'; }
function fmtActive(ms: number): string {
  const h = Math.floor(ms / 3600000); const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

const PAGE = 25;
type Mode = 'human' | 'all';
type Sort = 'cost' | 'duration' | 'recent';

export default function SessionsHubTab({ insights }: { insights: InsightsResult | null }): JSX.Element {
  const [, navigate] = useLocation();
  const { mode } = useCostMode();
  const [who, setWho] = useState<Mode>('human');
  const [sort, setSort] = useState<Sort>('cost');
  const [shown, setShown] = useState(PAGE);

  const automationIds = useMemo(() => new Set(insights?.machineSessions.ids ?? []), [insights]);
  // Per-session cost + tokens from the windowed cells (in-window share).
  const costBySession = useMemo(() => {
    const m = new Map<string, number>();
    if (!insights) return m;
    const by = groupByKey(insights.windowedTokensByModel, (c) => c.sessionId);
    for (const [id, cells] of by) m.set(id, costOfBucketedCells(cells, mode));
    return m;
  }, [insights, mode]);
  const tokBySession = useMemo(() => {
    const m = new Map<string, number>();
    if (!insights) return m;
    const by = sumByKeyModel(insights.windowedTokensByModel, (c) => c.sessionId);
    for (const [id, cell] of by) m.set(id, tokensOfCells(cell));
    return m;
  }, [insights]);

  const projectColors = useMemo(() => projectColorMap((insights?.projects ?? []).map((p) => p.id)), [insights]);

  // Interactive sessions only (human), or all incl. automation manifest ids.
  const rows = useMemo(() => {
    const all = insights?.sessions ?? [];
    return who === 'human' ? all.filter((s) => !automationIds.has(s.id)) : all;
  }, [insights, who, automationIds]);

  const sorted = useMemo(() => {
    const withVals = rows.map((s) => ({
      s, cost: costBySession.get(s.id) ?? 0, tokens: tokBySession.get(s.id) ?? 0,
      active: s.agent_active_ms ?? 0, started: s.started_at ? +new Date(s.started_at) : 0,
    }));
    withVals.sort((a, b) => sort === 'cost' ? b.cost - a.cost : sort === 'duration' ? b.active - a.active : b.started - a.started);
    return withVals;
  }, [rows, sort, costBySession, tokBySession]);

  // --- Aggregates (respect the toggle for days/projects; automation is always automation) ---
  const busiestDays = useMemo(() => {
    const m = new Map<string, { sessions: number; active: number; tokens: number; cost: number }>();
    for (const s of rows) {
      if (!s.started_at) continue;
      const day = dayKeyOf(new Date(s.started_at));
      const a = m.get(day) ?? { sessions: 0, active: 0, tokens: 0, cost: 0 };
      a.sessions++; a.active += s.agent_active_ms ?? 0; a.tokens += tokBySession.get(s.id) ?? 0; a.cost += costBySession.get(s.id) ?? 0;
      m.set(day, a);
    }
    return [...m.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 8);
  }, [rows, costBySession, tokBySession]);

  const busiestProjects = useMemo(() => {
    const m = new Map<number, { name: string; sessions: number; msgs: number; tokens: number; cost: number }>();
    for (const s of rows) {
      const a = m.get(s.project_id) ?? { name: s.project_name, sessions: 0, msgs: 0, tokens: 0, cost: 0 };
      a.sessions++; a.msgs += s.message_count ?? 0; a.tokens += tokBySession.get(s.id) ?? 0; a.cost += costBySession.get(s.id) ?? 0;
      m.set(s.project_id, a);
    }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 8);
  }, [rows, costBySession, tokBySession]);

  const automationByJob = useMemo(() => {
    const m = new Map<string, { runs: number; tokens: number; cost: number }>();
    for (const ms of insights?.machineSessions.sessions ?? []) {
      const a = m.get(ms.job) ?? { runs: 0, tokens: 0, cost: 0 };
      a.runs++;
      const u = ms.usage;
      a.tokens += (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite5m ?? 0) + (u?.cacheWrite1h ?? 0);
      a.cost += ms.cost_usd ?? 0;
      m.set(ms.job, a);
    }
    return [...m.entries()].map(([job, v]) => ({ job, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 8);
  }, [insights]);

  if (!insights) return <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>;

  const automationCount = insights.sessions.filter((s) => automationIds.has(s.id)).length;
  const visible = sorted.slice(0, shown);

  return (
    <div className="sessions-hub">
      <div className="sh-head">
        <span className="muted small">{fmtInt(rows.length)} {who === 'human' ? t('interactive sessions') : t('sessions (incl. automation)')}</span>
        <div className="sh-toggle">
          <div className="stack-toggle" role="group" aria-label={t('Session set')}>
            <button type="button" className={`st-opt ${who === 'human' ? 'on' : ''}`} onClick={() => setWho('human')}>{t('human')}</button>
            <button type="button" className={`st-opt ${who === 'all' ? 'on' : ''}`} onClick={() => setWho('all')}>{t('all')}</button>
          </div>
          <InfoTip text={t('Human shows only interactive sessions (matching the KPI Sessions count). All adds the headless automation jobs from ~/.aios/machine_sessions.jsonl (currently ') + automationCount + t(' automation runs). Automation-by-job below is always automation, unaffected by this toggle.')} />
        </div>
      </div>

      <div className="grid3">
        <div className="card">
          <h3>{t('Busiest days')}</h3>
          <table className="tbl"><thead><tr><th style={{ textAlign: 'left' }}>{t('Day')}</th><th>{t('Sessions')}</th><th>{t('Active')}</th><th>{t('Tokens')}</th><th className="sort-on">{t('Cost')}<SortCaret on /></th></tr></thead>
            <tbody>{busiestDays.map((d) => (
              <tr key={d.day}><td style={{ textAlign: 'left' }}>{fmtDayLabel(d.day, localeOf())}</td><td>{d.sessions}</td><td>{fmtActive(d.active)}</td><td>{fmtTok(d.tokens)}</td><td className="cost">{fmtMoney(d.cost, 2)}</td></tr>
            ))}</tbody></table>
          {!busiestDays.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
        </div>
        <div className="card">
          <h3>{t('Busiest projects')}</h3>
          <table className="tbl"><thead><tr><th style={{ textAlign: 'left' }}>{t('Project')}</th><th>{t('Sessions')}</th><th>{t('Msgs')}</th><th>{t('Tokens')}</th><th className="sort-on">{t('Cost')}<SortCaret on /></th></tr></thead>
            <tbody>{busiestProjects.map((p) => (
              <tr key={p.id}><td style={{ textAlign: 'left' }}><span className="dot" style={{ background: projectColors.get(p.id) ?? 'var(--ink-3)' }} />{p.name}</td><td>{p.sessions}</td><td>{fmtInt(p.msgs)}</td><td>{fmtTok(p.tokens)}</td><td className="cost">{fmtMoney(p.cost, 2)}</td></tr>
            ))}</tbody></table>
          {!busiestProjects.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
        </div>
        <div className="card">
          <h3>{t('Automation by job')} <InfoTip text={t('Always automation, unaffected by the human/all toggle — sourced from the ~/.aios/machine_sessions.jsonl manifest (weekly / nightly / session-close / spend-advice jobs).')} /></h3>
          <table className="tbl"><thead><tr><th style={{ textAlign: 'left' }}>{t('Job')}</th><th>{t('Runs')}</th><th>{t('Tokens')}</th><th className="sort-on">{t('Cost')}<SortCaret on /></th></tr></thead>
            <tbody>{automationByJob.map((j) => (
              <tr key={j.job}><td style={{ textAlign: 'left' }}>{j.job}</td><td>{j.runs}</td><td>{fmtTok(j.tokens)}</td><td className="cost">{fmtMoney(j.cost, 2)}</td></tr>
            ))}</tbody></table>
          {!automationByJob.length && <div className="muted small pad8">{t('No automation runs in range.')}</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <div className="sh-tablehead">
          <h3 style={{ margin: 0 }}>{t('Sessions')}</h3>
          <div className="stack-toggle" role="group" aria-label={t('Sort by')}>
            <button type="button" className={`st-opt ${sort === 'cost' ? 'on' : ''}`} onClick={() => setSort('cost')}>{t('cost')}</button>
            <button type="button" className={`st-opt ${sort === 'duration' ? 'on' : ''}`} onClick={() => setSort('duration')}>{t('duration')}</button>
            <button type="button" className={`st-opt ${sort === 'recent' ? 'on' : ''}`} onClick={() => setSort('recent')}>{t('recent')}</button>
          </div>
        </div>
        <div className="pane">
          <table className="tbl sh-sessions-table">
            <colgroup>
              <col className="c-session" /><col className="c-proj" /><col className="c-src" />
              <col className="c-num" /><col className="c-num" /><col className="c-num" /><col className="c-num" />
            </colgroup>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>{t('Session')}</th><th style={{ textAlign: 'left' }}>{t('Project')}</th>
              <th style={{ textAlign: 'left' }}>{t('Source')}</th>
              <th>{t('Ctx')} <InfoTip text={t('Context tokens — the size of the context window fed to the model for this session (input + cache-read), a proxy for how heavy the session ran.')} /></th>
              <th className={sort === 'duration' ? 'sort-on' : ''}>{t('Active')}<SortCaret on={sort === 'duration'} /></th>
              <th className={sort === 'cost' ? 'sort-on' : ''}>{t('Cost')}<SortCaret on={sort === 'cost'} /></th>
              <th className={sort === 'recent' ? 'sort-on' : ''}>{t('When')}<SortCaret on={sort === 'recent'} /></th>
            </tr></thead>
            <tbody>{visible.map(({ s, cost, active }) => (
              <tr key={s.id} className="rowlink" onClick={() => navigate(`/session/${encodeURIComponent(s.id)}`)}>
                <td title={sessionDisplayName(s)}>{sessionDisplayName(s)}</td>
                <td style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.project_name}><span className="dot" style={{ background: projectColors.get(s.project_id) ?? 'var(--ink-3)' }} />{s.project_name}</td>
                <td style={{ textAlign: 'left' }}><span className="src-pill">{s.source}</span></td>
                <td>{s.context_tokens ? fmtTok(s.context_tokens) : '—'}</td>
                <td className={sort === 'duration' ? 'sort-on' : ''}>{fmtActive(active)}</td>
                <td className={sort === 'cost' ? 'sort-on' : ''}>{fmtMoney(cost, 2)}</td>
                <td className={sort === 'recent' ? 'sort-on' : ''}>{formatRelativeTime(s.started_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!sorted.length && <div className="muted small pad8">{t('No sessions in range.')}</div>}
        {shown < sorted.length && (
          <button type="button" className="more-btn" onClick={() => setShown((n) => n + PAGE)}>
            {fmtInt(sorted.length - shown)} {t('more sessions')}
          </button>
        )}
      </div>
    </div>
  );
}
