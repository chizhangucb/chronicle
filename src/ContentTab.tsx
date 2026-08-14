import React, { useMemo, type JSX } from 'react';
import { contentUrl, type CharacteristicKey, type ContentResult } from './api.ts';
import { t } from './i18n.ts';
import { CATEGORICAL_COLORS } from './colors.ts';
import { shakespeareMultiple } from './insights/stats.ts';
import { pluralize } from './format.ts';
import InfoTip from './InfoTip.tsx';
import type { Scope } from './ExploreTab.tsx';
import { useCachedFetch } from './useCachedFetch.ts';

// Mounted by both HomeDashboard (the Home hub, scope {type:all}) and ProjectDetail
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

// The 7 independent usage characteristics (spec §2.5) — display metadata.
// `label` follows the bold "N% ..." lead-in; `why` is the one-line plain-
// language explainer under it; `info` is the FULL-SENTENCE InfoTip copy
// (i18n keys are the literal English sentence, per src/i18n.ts's convention);
// `countOne`/`countMany` feed `pluralize()` for the "(N sessions)" suffix.
const CHARACTERISTIC_META: Record<CharacteristicKey, {
  label: string; why: string; info: string; countOne: string; countMany: string;
}> = {
  eightHourSessions: {
    label: 'of usage came from marathon sessions (8h+ active)',
    why: 'Sessions where the agent was actively working — not just open — for 8 hours or more.',
    info: 'Agent-active time sums every gap between messages except the ones spent waiting on you to type a prompt, capped at 10 minutes per gap unless a long-running tool call fills it — a session counts here once that total reaches 8 hours. Sessions without a stored duration (not yet re-synced) are left out of this share entirely, on both sides of the percentage.',
    countOne: 'marathon session', countMany: 'marathon sessions',
  },
  workflowRuns: {
    label: 'of usage ran inside a multi-agent workflow',
    why: 'Tokens spent on groups of subagents launched together to divide one task.',
    info: 'A workflow run is a group of subagents nested under one shared workflow folder — this is their exact share of billed tokens, not a text-length estimate.',
    countOne: 'workflow run', countMany: 'workflow runs',
  },
  subagentTurns: {
    label: 'of usage came from subagent turns',
    why: 'Work delegated to Task-launched subagents rather than answered on the main thread.',
    info: "Counts every reply a subagent produced, exact from Chronicle's per-message sidechain token columns — includes both workflow and standalone subagent runs.",
    countOne: 'subagent turn', countMany: 'subagent turns',
  },
  highContextAbs: {
    label: 'of usage ran above 150k context tokens',
    why: "Sessions carrying a large context regardless of the model's window size.",
    info: "Flags sessions whose stored context size passed 150,000 tokens — an absolute cutoff, independent of which model or context-window size was in use. Sessions with no stored context size (some non-Claude-Code sources, or an import from before context tracking was added) are left out of this share entirely, on both sides of the percentage.",
    countOne: 'session', countMany: 'sessions',
  },
  highContextRel: {
    label: "of usage ran past 70% of the model's context window",
    why: "Chronicle's own heuristic threshold — not a documented Claude Code auto-compact trigger.",
    info: "Compares each session's stored context size against its model's context window. 70% is a heuristic threshold Chronicle chose to flag rising cost, not a documented auto-compact point — Claude Code doesn't publish a fixed default for the 200K window, and the 1M window auto-compacts around 97%, well past 70%. Sessions with no stored context size are left out of this share entirely, on both sides of the percentage.",
    countOne: 'session', countMany: 'sessions',
  },
  cacheEfficiency: {
    label: 'of input tokens were served from cache',
    why: 'Higher is cheaper — a cache read costs a fraction of a fresh input token.',
    info: "The share of input-side tokens (fresh input plus cache reads) that came from cache reads, computed directly from each session's billed usage.",
    countOne: 'session with cache activity', countMany: 'sessions with cache activity',
  },
  autonomousShare: {
    label: 'of usage ran mostly unattended',
    why: 'Engaged (wall-clock) time stayed under a quarter of active time — the agent worked largely without you watching.',
    info: 'Flags sessions where engaged time (your wall-clock presence) is under 25% of agent-active time (the agent\'s working time) — for example, a long build or tool call that ran while you stepped away. Sessions without stored duration data (not yet re-synced) are left out of this share entirely, on both sides of the percentage.',
    countOne: 'session', countMany: 'sessions',
  },
};

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

  // Mirrors ExploreTab.tsx's rangeLabel: `days` can be a FRACTIONAL
  // days-since-local-midnight value for "Today" (ProjectDetail.tsx/
  // HomeDashboard.tsx), so `${days}d` alone leaked a raw float like
  // "0.224…d" here — the same bug class the window/float-day-leak fix
  // already covered in ExploreTab's card title, just missed in this file's
  // composition footer (caught live by test/e2e/window-matrix.spec.ts).
  const rangeLabel = days == null ? t('All') : days < 1 ? t('Today') : `${Math.round(days)}d`;

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
        <h3>{t('Usage characteristics')}</h3>
        {result.characteristics.map((c) => {
          const meta = CHARACTERISTIC_META[c.key];
          return (
            <div className="callout" key={c.key}>
              <b>
                {c.share}% {t(meta.label)}
                {!c.exact && (
                  <>
                    {' ≈'}
                    <InfoTip text={t('Estimated from message text length, scaled to billed totals — tool/skill token attribution is approximate.')} />
                  </>
                )}
                {' '}<InfoTip text={t(meta.info)} />
              </b>
              <div className="why">
                {t(meta.why)}
                {typeof c.count === 'number' && c.count > 0 && ` (${pluralize(c.count, t(meta.countOne), t(meta.countMany))})`}
              </div>
            </div>
          );
        })}
        {!result.characteristics.length && <div className="muted small">{t('No sessions in range.')}</div>}
      </div>

      <div className="card">
        <h3>{t('Token composition · what fills the context')}</h3>
        {result.composition.map((c, i) => {
          const share = compositionTotal ? (c.tokens / compositionTotal) * 100 : 0;
          return (
            <div className="rank" key={c.key}>
              <span className="n" title={t(COMPOSITION_LABELS[c.key] ?? c.key)}>{t(COMPOSITION_LABELS[c.key] ?? c.key)}</span>
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
                <span className="n" title={r.key}>{r.key}</span>
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
              <span className="n" title={s.key}>{s.key}</span>
              <div className="track"><i style={{ width: `${(s.tokens / skillsView.max) * 100}%`, background: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] }} /></div>
              <span className="v">×{s.count}</span>
            </div>
          ))}
          {skillsView.skillsMore > 0 && <div className="muted small">{t('+{n} more').replace('{n}', String(skillsView.skillsMore))}</div>}
          {skillsView.subagents.map((s, i) => (
            <div className="rank nopct" key={`subagent-${s.key}`}>
              <span className="n" title={s.key}>{s.key}</span>
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
