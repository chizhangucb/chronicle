import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { insightsUrl, activityUrl, type InsightsResult, type ActivityResult, type ActivityTokensByModel, type ActivitySessionLite } from './api.js';
import { KpiStrip } from './InsightsPage.js';
import RecentLedger from './RecentLedger.js';
import { WelcomeEmpty } from './ProjectsPage.js';
import type { ProjectSummary } from './ProjectsPage.js';
import { useCachedFetch } from './useCachedFetch.ts';
import { costOf } from './models.js';
import { fmtMoney, pluralize } from './format.js';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';
import InfoTip from './InfoTip.tsx';

// New `/` home (Task 13, spec §2.1): an Insights-overview dashboard. Reading
// order top→bottom: Today strip (shared KpiStrip) → Activity block (live +
// since-you-left, Today only) → Burn tile (current window vs baseline) → the
// existing Recent-sessions ledger LAST. The project grid moved to /projects.

type WindowKey = 'today' | '7d' | '30d';
const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
];

// Price a bag of per-model token cells client-side (the price table lives ONLY
// in src/models.ts — hard constraint; the server returns tokens, never $).
function priceCells(byModel: ActivityTokensByModel): number {
  let total = 0;
  for (const [model, cell] of Object.entries(byModel)) total += costOf(model, cell) ?? 0;
  return total;
}

export interface HomeDashboardProps {
  projects: ProjectSummary[] | null;
  onOpenProject: (id: number | string) => void;
  onOpenSession?: (id: string, projectId: number) => void;
  onImport: () => void;
  onRefresh: () => void;
}

// localStorage key holding the last time the user left the app — sent as
// `?since=` so the Activity block can show "since you left". Written on tab
// hide / pagehide (more reliable than `unload`, which is unreliable on mobile
// and back-forward-cache navigations); read ONCE at mount BEFORE the writer
// fires, so `since` reflects the PREVIOUS visit, not this one.
const LAST_VISIT_KEY = 'chronicle.lastVisit';

export default function HomeDashboard({ projects, onOpenSession, onImport, onRefresh }: HomeDashboardProps) {
  const [win, setWin] = useState<WindowKey>('today');

  // Fractional days since LOCAL midnight — same "Today" semantics as
  // ProjectDetail. Memoized so it's stable within a mount (a fresh mount on
  // navigation recomputes it).
  const daysToday = useMemo(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.max((now.getTime() - midnight) / 86400000, 1 / 1440); // ≥1 min, never 0
  }, []);
  const days = win === 'today' ? daysToday : win === '7d' ? 7 : 30;
  const isToday = win === 'today';

  // Read the previous visit time once (before the unload writer overwrites it).
  const sinceRef = useRef<string | null>(null);
  if (sinceRef.current === null) sinceRef.current = localStorage.getItem(LAST_VISIT_KEY);
  useEffect(() => {
    const write = () => {
      // Only persist when actually leaving/hidden, so a same-session revisit
      // still sees the original "since".
      if (document.visibilityState === 'hidden') localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    };
    const onPageHide = () => localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    document.addEventListener('visibilitychange', write);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', write);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  const { data: insights } = useCachedFetch<InsightsResult>(insightsUrl(days));
  const { data: activity } = useCachedFetch<ActivityResult>(activityUrl(sinceRef.current, days));

  if (projects === null) return <div className="page center muted">Loading…</div>;
  if (!projects.length) return <WelcomeEmpty onImport={onImport} />;

  return (
    <div className="page home-dashboard">
      <div className="home-dash">
        <div className="dash-head">
          <h1 className="page-title">{t('Home')}</h1>
          <div className="rangebar" role="tablist" aria-label={t('Time range')}>
            {WINDOWS.map((w) => (
              <button key={w.key} type="button" role="tab" aria-selected={win === w.key}
                className={win === w.key ? 'on' : ''} onClick={() => setWin(w.key)}>
                {w.key === 'today' ? t('Today') : w.label}
              </button>
            ))}
          </div>
        </div>

        {insights
          ? <KpiStrip result={insights} />
          : <div className="muted pad8">{t('Loading…')}</div>}

        {isToday && <ActivityBlock activity={activity} onOpenSession={onOpenSession} />}

        <BurnTile activity={activity} win={win} onOpenSession={onOpenSession} />
      </div>

      <RecentLedger projects={projects} onOpenSession={onOpenSession} onRefresh={onRefresh} />
    </div>
  );
}

// ---- Activity block: live now + since-you-left. Shown only on the Today
// window (a 7d/30d "since you left" makes no sense). ----
function ActivityBlock({ activity, onOpenSession }: { activity: ActivityResult | null; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  const open = (s: ActivitySessionLite) => (onOpenSession ? onOpenSession(s.id, 0) : navigate(`/session/${encodeURIComponent(s.id)}`));
  const live = activity?.live ?? [];
  const recent = activity?.recent ?? [];

  if (!activity) return <div className="card activity-card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  if (!live.length && !recent.length) {
    return (
      <div className="card activity-card">
        <div className="muted small pad8">{t('No activity yet today — your live and recently-ended sessions will show here.')}</div>
      </div>
    );
  }

  const Row = ({ s }: { s: ActivitySessionLite }) => (
    <div className="activity-row" onClick={() => open(s)}>
      <span className={`live-dot ${s.live ? 'on' : ''}`} aria-hidden="true" />
      <span className="ar-name">{s.name}</span>
      <span className="ar-proj muted">{s.projectName}</span>
      {s.errorCount > 0 && <span className="ar-err">{pluralize(s.errorCount, t('error'), t('errors'))}</span>}
      <span className="ar-when muted">{s.live ? t('live') : formatRelativeTime(s.endedAt)}</span>
      <span className="ar-cost num-col">{fmtMoney(priceCells(s.tokensByModel), 2)}</span>
    </div>
  );

  return (
    <div className="card activity-card">
      {live.length > 0 && (
        <div className="activity-group">
          <div className="eyebrow">{t('Live now')}</div>
          {live.map((s) => <Row key={s.id} s={s} />)}
        </div>
      )}
      {recent.length > 0 && (
        <div className="activity-group">
          <div className="eyebrow">{t('Since you left')}</div>
          {recent.map((s) => <Row key={s.id} s={s} />)}
        </div>
      )}
    </div>
  );
}

// ---- Burn tile: current window spend vs a baseline (Today → 14-day daily
// median; Nd → prior-Nd). Warn tint (--warn) when spend runs >2× the baseline.
// A thin comparison bar + a slim top-cost block. All $ priced client-side. ----
function BurnTile({ activity, win, onOpenSession }: { activity: ActivityResult | null; win: WindowKey; onOpenSession?: (id: string, projectId: number) => void }) {
  const [, navigate] = useLocation();
  if (!activity) return <div className="card burn-card"><div className="muted small pad8">{t('Loading…')}</div></div>;
  const burn = activity.burn;
  const current = priceCells(burn.windowSpendTokensByModel);
  const baseline = priceCells(burn.baselineTokensByModel);
  const ratio = baseline > 0 ? current / baseline : null;
  const hot = ratio != null && ratio > 2;
  const baselineLabel = win === 'today' ? t('typical day (14-day median)') : win === '7d' ? t('prior 7 days') : t('prior 30 days');
  // Comparison bar: baseline is the 100% reference; current fills relative to it
  // (capped at 100% width so a huge overshoot doesn't blow out the row — the
  // ratio badge carries the real magnitude).
  const fillPct = baseline > 0 ? Math.min((current / baseline) * 100, 100) : (current > 0 ? 100 : 0);

  const topCost = priceCells(burn.topSessionTokensByModel);
  const openTop = () => {
    if (!burn.topSessionId) return;
    if (onOpenSession) onOpenSession(burn.topSessionId, 0);
    else navigate(`/session/${encodeURIComponent(burn.topSessionId)}`);
  };

  return (
    <div className={`card burn-card ${hot ? 'warn' : ''}`}>
      <div className="burn-head">
        <span className="eyebrow">{t('Burn rate')}</span>
        <InfoTip text={t('Your spend in this window versus a baseline (Today uses the median of the last 14 complete days; longer windows use the prior period). Over 2× the baseline is flagged.')} />
      </div>
      <div className="burn-row">
        <div className="burn-now">
          <div className="v">{fmtMoney(current, current < 1 ? 2 : 0)}</div>
          <div className="s muted">{t('vs')} {fmtMoney(baseline, baseline < 1 ? 2 : 0)} · {baselineLabel}</div>
        </div>
        {ratio != null && (
          <div className={`burn-ratio ${hot ? 'hot' : ''}`}>
            ×{ratio.toFixed(1)}{hot && <span className="burn-flag"> {t('high')}</span>}
          </div>
        )}
      </div>
      <div className="burn-bar" aria-hidden="true">
        <div className="burn-baseline" />
        <div className={`burn-fill ${hot ? 'hot' : ''}`} style={{ width: `${fillPct}%` }} />
      </div>
      {burn.topSessionId && (
        <div className="burn-top" onClick={openTop} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') openTop(); }}>
          <span className="eyebrow">{t('Top session')}</span>
          <span className="bt-name">{burn.topSessionName}</span>
          <span className="bt-cost num-col">{fmtMoney(topCost, 2)}</span>
        </div>
      )}
    </div>
  );
}
