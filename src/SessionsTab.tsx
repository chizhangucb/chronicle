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

// The Sessions tab: the ANALYZE half of the two session lists
// (the /projects ledger is the MANAGE half). Header count → two-up aggregates
// (busiest days · busiest projects) → ONE flat sessions table (chips
// cost|duration|recent, cost default), click-to-extend. All spend is priced
// client-side from the windowed cells.

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
type Sort = 'cost' | 'duration' | 'recent';

export default function SessionsTab({ insights }: { insights: InsightsResult | null }): JSX.Element {
  const [, navigate] = useLocation();
  const { mode } = useCostMode();
  const [sort, setSort] = useState<Sort>('cost');
  const [shown, setShown] = useState(PAGE);

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

  const rows = useMemo(() => insights?.sessions ?? [], [insights]);

  const sorted = useMemo(() => {
    const withVals = rows.map((s) => ({
      s, cost: costBySession.get(s.id) ?? 0, tokens: tokBySession.get(s.id) ?? 0,
      active: s.agent_active_ms ?? 0, started: s.started_at ? +new Date(s.started_at) : 0,
    }));
    withVals.sort((a, b) => sort === 'cost' ? b.cost - a.cost : sort === 'duration' ? b.active - a.active : b.started - a.started);
    return withVals;
  }, [rows, sort, costBySession, tokBySession]);

  // --- Aggregates ---
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

  if (!insights) return <div className="card"><div className="muted small pad8">{t('Loading…')}</div></div>;

  const visible = sorted.slice(0, shown);

  return (
    <div className="sessions-tab">
      <div className="sh-head">
        <span className="muted small">{fmtInt(rows.length)} {t('sessions')}</span>
      </div>

      <div className="grid2b">
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
              <col className="c-ctx" /><col className="c-active" /><col className="c-cost" /><col className="c-when" />
            </colgroup>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>{t('Session')}</th><th style={{ textAlign: 'left' }}>{t('Project')}</th>
              <th style={{ textAlign: 'left' }}>{t('Source')}</th>
              <th>{t('Ctx')} <InfoTip def="sessions.context-tokens" /></th>
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
