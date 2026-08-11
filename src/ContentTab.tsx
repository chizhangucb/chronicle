import React, { useEffect, useMemo, useState, type JSX } from 'react';
import { api, type ContentResult } from './api.ts';
import { t } from './i18n.ts';
import { CATEGORICAL_COLORS } from './colors.ts';
import { shakespeareMultiple } from './insights/stats.ts';
import InfoTip from './InfoTip.tsx';
import type { Scope } from './ExploreTab.tsx';

// Mounted by both InsightsPage (5e-2, scope {type:'all'}) and ProjectDetail
// (5e-4, scope {type:'project'|'session', id}) — generic from day one, same
// convention as ExploreTab.tsx (5e-1).
export interface ContentTabProps {
  scope: Scope;
  days: number | null;
}

// ---- Local formatter (mirrors InsightsPage.tsx / ExploreTab.tsx's file-local
// fmtTok — kept local per those files' own note about not sharing it). ----
function fmtTok(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

// Message-kind → display label, matching content.html's composition rows.
// server/content.ts's KINDS order (tool_result, tool_use, user, assistant,
// thinking) is what result.composition arrives in — no client re-sort needed.
const COMPOSITION_LABELS: Record<string, string> = {
  tool_result: 'Tool results',
  tool_use: 'Tool calls',
  user: 'Your prompts',
  assistant: 'Assistant responses',
  thinking: 'Thinking',
};

export default function ContentTab({ scope, days }: ContentTabProps): JSX.Element {
  const [result, setResult] = useState<ContentResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    api.content(scope.type, scope.id, days ?? undefined).then((r) => { if (!cancelled) setResult(r); }).catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [scope.type, scope.id, days]);

  const rangeLabel = days ? `${days}d` : t('All');

  // Composition bar widths are the share OF THE COMPOSITION LIST ITSELF (sums
  // to 100%), matching content.html's rows (74/12/7/5/2 = ~100).
  const compositionTotal = useMemo(() => (result ? result.composition.reduce((n, c) => n + c.tokens, 0) : 0), [result]);

  // Tool-results-by-tool: top 6, bar width relative to the top tool (like
  // ExploreTab's ranked bars), % share relative to the FULL tool-results
  // token pool (not just the displayed top 6).
  const toolResultsTop = useMemo(() => {
    if (!result) return { rows: [] as ContentResult['toolResultsByTool'], total: 0, max: 1e-9 };
    const total = result.toolResultsByTool.reduce((n, r) => n + r.tokens, 0);
    const rows = result.toolResultsByTool.slice(0, 6);
    const max = Math.max(1e-9, ...rows.map((r) => r.tokens));
    return { rows, total, max };
  }, [result]);

  // Skills & subagents: skills are now a true fraction of `billed` (share of
  // ALL content) and subagents are exact-per-message, so both are expressed as
  // a share of the REAL total (calibratedTotalTokens) — a subpool denominator
  // would mix two incommensurable pools. Each row's bar WIDTH == its displayed
  // %, so bar and label agree. Guard divide-by-zero.
  const skillsTotal = useMemo(() => (result && result.calibratedTotalTokens > 0 ? result.calibratedTotalTokens : 0), [result]);

  if (!result) return <div className="muted pad8">{t('Loading…')}</div>;

  const { callouts } = result;

  return (
    <>
      <div className="card">
        <h3>{t('What your usage says')}</h3>
        <div className={`callout${callouts.contextPressureShare >= 40 ? ' warn' : ''}`}>
          <b>{callouts.contextPressureShare}% {t('of your usage ran at >70% context')}</b>
          <div className="why">{t('Long sessions are pricier even when cached. Splitting tasks or compacting mid-task would cut cache-write spend.')}</div>
        </div>
        <div className="callout">
          <b>{callouts.subagentHeavyShare}% {t('of tokens came from subagent-heavy sessions')}</b>
          <div className="why">{t('Each subagent pays its own context. Worth it for parallel work; watch it on simple tasks.')}</div>
        </div>
        <div className="callout">
          <b>{t('Cache stays warm ~')}{callouts.cacheWarmthMinutes}{t(' min between your turns')}</b>
          <div className="why">{t('Estimated from same-model turn gaps. Keeping a task moving inside that window avoids cold-cache rewrites.')}</div>
        </div>
      </div>

      <div className="card">
        <h3>{t('Token composition · what fills the context')}</h3>
        {result.composition.map((c, i) => {
          const share = compositionTotal ? (c.tokens / compositionTotal) * 100 : 0;
          return (
            <div className="rank" key={c.key}>
              <span className="n">{t(COMPOSITION_LABELS[c.key] ?? c.key)}</span>
              <div className="track"><i style={{ width: `${share}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
              <span className="v">{fmtTok(c.tokens)}</span>
              <span className="p">{share.toFixed(1)}%</span>
            </div>
          );
        })}
        <div className="note">{t('Shares from message text length, scaled to billed totals. Everything computed locally.')}</div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>
            {t('Tool results by tool')}
            {result.calibrated && (
              <>
                {' ≈'}
                <InfoTip text={t('Estimated from message text length, scaled to billed totals — tool/skill token attribution is approximate.')} />
              </>
            )}
          </h3>
          {toolResultsTop.rows.map((r, i) => {
            const share = toolResultsTop.total ? (r.tokens / toolResultsTop.total) * 100 : 0;
            const width = (r.tokens / toolResultsTop.max) * 100;
            return (
              <div className="rank" key={r.key}>
                <span className="n">{r.key}</span>
                <div className="track"><i style={{ width: `${width}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v">{fmtTok(r.tokens)}</span>
                <span className="p">{share.toFixed(1)}%</span>
              </div>
            );
          })}
          {!toolResultsTop.rows.length && <div className="muted small">{t('No sessions in range.')}</div>}
        </div>
        <div className="card">
          <h3>
            {t('Skills & subagents')}
            {result.calibrated && (
              <>
                {' ≈'}
                <InfoTip text={t('Estimated from message text length, scaled to billed totals — tool/skill token attribution is approximate.')} />
              </>
            )}
          </h3>
          {result.skills.map((s, i) => {
            const share = skillsTotal ? (s.tokens / skillsTotal) * 100 : 0;
            const width = share;
            return (
              <div className="rank" key={`skill-${s.key}`}>
                <span className="n">{s.key}</span>
                <div className="track"><i style={{ width: `${width}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v">×{s.count}</span>
                <span className="p">{share.toFixed(1)}%</span>
              </div>
            );
          })}
          {result.subagents.map((s, i) => {
            const share = skillsTotal ? (s.tokens / skillsTotal) * 100 : 0;
            const width = share;
            return (
              <div className="rank" key={`subagent-${s.key}`}>
                <span className="n">{s.key}</span>
                <div className="track"><i style={{ width: `${width}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
                <span className="v">×{s.runs}</span>
                <span className="p">{share.toFixed(1)}%</span>
              </div>
            );
          })}
          {!result.skills.length && !result.subagents.length && <div className="muted small">{t('No sessions in range.')}</div>}
          <div className="note">{t('Top: skill invocations · bottom: subagent runs. % = share of tokens.')}</div>
        </div>
      </div>

      <div className="fun">
        {t('Calibrated tokens {range}: {total} — about {n}× the complete works of Shakespeare.')
          .replace('{range}', rangeLabel)
          .replace('{total}', result.calibratedTotalTokens.toLocaleString())
          .replace('{n}', String(shakespeareMultiple(result.calibratedTotalTokens)))}
      </div>
    </>
  );
}
