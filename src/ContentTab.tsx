import React, { useMemo, type JSX } from 'react';
import { contentUrl, type ContentResult } from './api.ts';
import { t } from './i18n.ts';
import { CATEGORICAL_COLORS } from './colors.ts';
import { shakespeareMultiple } from './insights/stats.ts';
import InfoTip from './InfoTip.tsx';
import type { Scope } from './ExploreTab.tsx';
import { useCachedFetch } from './useCachedFetch.ts';

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
  const { data: result } = useCachedFetch<ContentResult>(contentUrl(scope.type, scope.id, days ?? undefined));

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

  // Skills & subagents: the old %-of-billed share read 0.0% on every row (a
  // skill's tokens are tiny against the whole-content pool), so the column was
  // dropped — rows now show the invocation/run COUNT only, with a magnitude bar
  // sized against the heaviest displayed row (skills + subagents share one
  // scale). Capped at 8 each (mirrors the Tool-results top-6) with a "+N more"
  // affordance, so a long skill list can't blow out the card height.
  const SKILLS_CAP = 8;
  const skillsView = useMemo(() => {
    if (!result) return { skills: [], subagents: [], max: 1, skillsMore: 0, subagentsMore: 0 };
    const skills = result.skills.slice(0, SKILLS_CAP);
    const subagents = result.subagents.slice(0, SKILLS_CAP);
    const max = Math.max(1, ...skills.map((s) => s.tokens), ...subagents.map((s) => s.tokens));
    return {
      skills, subagents, max,
      skillsMore: result.skills.length - skills.length,
      subagentsMore: result.subagents.length - subagents.length,
    };
  }, [result]);

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
        {callouts.cacheWarmthMinutes >= 1 && (
          <div className="callout">
            <b>{t('Cache stays warm ~')}{callouts.cacheWarmthMinutes}{t(' min between your turns')}</b>
            <div className="why">{t('Estimated from same-model turn gaps. Keeping a task moving inside that window avoids cold-cache rewrites.')}</div>
          </div>
        )}
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
          {skillsView.skills.map((s, i) => (
            <div className="rank nopct" key={`skill-${s.key}`}>
              <span className="n">{s.key}</span>
              <div className="track"><i style={{ width: `${(s.tokens / skillsView.max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
              <span className="v">×{s.count}</span>
            </div>
          ))}
          {skillsView.skillsMore > 0 && <div className="muted small">{t('+{n} more').replace('{n}', String(skillsView.skillsMore))}</div>}
          {skillsView.subagents.map((s, i) => (
            <div className="rank nopct" key={`subagent-${s.key}`}>
              <span className="n">{s.key}</span>
              <div className="track"><i style={{ width: `${(s.tokens / skillsView.max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
              <span className="v">×{s.runs}</span>
            </div>
          ))}
          {skillsView.subagentsMore > 0 && <div className="muted small">{t('+{n} more').replace('{n}', String(skillsView.subagentsMore))}</div>}
          {!skillsView.skills.length && !skillsView.subagents.length && <div className="muted small">{t('No sessions in range.')}</div>}
          <div className="note">{t('Top: skill invocations · bottom: subagent runs.')}</div>
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
