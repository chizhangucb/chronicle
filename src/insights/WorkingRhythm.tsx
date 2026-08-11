import React, { useMemo, type JSX } from 'react';
import { t, lang } from '../i18n.ts';
import { currentStreak, longestStreak, activeDaysCount, peakHour, shakespeareMultiple } from './stats.ts';
import type { InsightsResult } from '../api.ts';

export interface WorkingRhythmProps {
  result: InsightsResult;
}

const CAL_WEEKS = 26;
const HOURLY_WINDOW_DAYS = 30;

const INTL_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };

function localeOf(): string {
  return INTL_LOCALE[lang()] ?? 'en-US';
}

// UTC-safe: `dailyActivity`/`hourlyActivity` days are `substr(ts,1,10)` — the
// UTC calendar date of each message — so all date math here stays in UTC to
// match, rather than drifting against the browser's local timezone.
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// Monday on/before `d` (UTC). getUTCDay(): 0=Sun..6=Sat; Monday-first offset.
function mondayOnOrBefore(d: Date): Date {
  const dow = d.getUTCDay();
  return addDaysUtc(d, -((dow + 6) % 7));
}

// 5-level quantile bucket against a grid's own max (brief spec: `Math.min(5,
// Math.ceil((count / maxCount) * 5))`), 0 (empty) when count is 0.
function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(5, Math.ceil((count / max) * 5));
}

export default function WorkingRhythm({ result }: WorkingRhythmProps): JSX.Element {
  const today = todayUtc();
  const todayStr = isoDay(today);

  const activeDays30 = activeDaysCount(result.dailyActivity, 30, todayStr);
  const streak = currentStreak(result.dailyActivity, todayStr);
  const longest = longestStreak(result.dailyActivity);
  const peak = peakHour(result.hourlyActivity);
  const favoriteModel = result.modelDist[0]?.model ?? '—';

  const totalTokens = useMemo(() => {
    let sum = 0;
    for (const s of result.sessions) {
      if (!s.usage) continue;
      try {
        const usage = JSON.parse(s.usage) as Record<string, { input?: number; output?: number }>;
        for (const u of Object.values(usage)) sum += (u.input || 0) + (u.output || 0);
      } catch { /* malformed usage JSON — skip */ }
    }
    return sum;
  }, [result.sessions]);
  const shakespeare = shakespeareMultiple(totalTokens);

  // ---- Calendar heatmap: 26 real Mon–Sun weeks (columns), ending the week
  // containing "today" (a partial last column is normal). ----
  const gridEndMonday = mondayOnOrBefore(today);
  const gridStartMonday = addDaysUtc(gridEndMonday, -(CAL_WEEKS - 1) * 7);
  const byDay = useMemo(() => new Map(result.dailyActivity.map((d) => [d.day, d.count])), [result.dailyActivity]);
  const calMax = useMemo(() => Math.max(0, ...result.dailyActivity.map((d) => d.count)), [result.dailyActivity]);

  const calColumns = useMemo(() => {
    const cols: { date: string; count: number }[][] = [];
    for (let w = 0; w < CAL_WEEKS; w++) {
      const weekMonday = addDaysUtc(gridStartMonday, w * 7);
      const col: { date: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = addDaysUtc(weekMonday, d);
        const key = isoDay(date);
        col.push({ date: key, count: date > today ? 0 : (byDay.get(key) ?? 0) });
      }
      cols.push(col);
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byDay, gridStartMonday.getTime(), today.getTime()]);

  const monthLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(localeOf(), { month: 'short' });
    const labels: string[] = [];
    let lastMonth = -1;
    for (let w = 0; w < CAL_WEEKS; w++) {
      const weekMonday = addDaysUtc(gridStartMonday, w * 7);
      const m = weekMonday.getUTCMonth();
      if (m !== lastMonth) { labels.push(fmt.format(weekMonday)); lastMonth = m; }
    }
    return labels;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStartMonday.getTime()]);

  // Mon/Wed/Fri/Sun row labels (a sparse subset of the 7 weekday rows, per the
  // mockup's `.cal-days` axis) — computed from real weekday names, not hardcoded English.
  const weekdayFmt = new Intl.DateTimeFormat(localeOf(), { weekday: 'short' });
  // A known UTC Monday to derive any weekday's localized short name from.
  const REF_MONDAY = new Date(Date.UTC(2024, 0, 1)); // 2024-01-01 is a Monday
  const calDayLabels = [0, 2, 4, 6].map((mondayOffset) => weekdayFmt.format(addDaysUtc(REF_MONDAY, mondayOffset)));

  // ---- Hour-of-day heatmap: 7 rows (Mon..Sun) x 24 columns, trailing 30d. ----
  const hourByCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of result.hourlyActivity) m.set(`${h.dow}:${h.hour}`, (m.get(`${h.dow}:${h.hour}`) ?? 0) + h.count);
    return m;
  }, [result.hourlyActivity]);
  const hourMax = useMemo(() => Math.max(0, ...result.hourlyActivity.map((h) => h.count)), [result.hourlyActivity]);
  // Row order Mon..Sun; SQLite strftime('%w') dow is 0=Sun..6=Sat.
  const ROW_DOWS = [1, 2, 3, 4, 5, 6, 0];
  const rowLabels = ROW_DOWS.map((dow) => weekdayFmt.format(addDaysUtc(REF_MONDAY, (dow + 6) % 7)));

  const peakHourLabel = peak == null ? '—' : `${peak % 12 || 12} ${peak < 12 ? t('AM') : t('PM')}`;

  return (
    <div className="card">
      <h3>{t('Working rhythm')}</h3>
      <div className="rhythm">
        <div className="r"><span className="rl2">{t('Active days')}</span><b className="num">{activeDays30}<i>/30</i></b></div>
        <div className="r"><span className="rl2">{t('Current streak')}</span><b className="num">{streak}d</b></div>
        <div className="r"><span className="rl2">{t('Longest streak')}</span><b className="num">{longest}d</b></div>
        <div className="r"><span className="rl2">{t('Peak hour')}</span><b className="num">{peakHourLabel}</b></div>
        <div className="r"><span className="rl2">{t('Favorite model')}</span><b className="num">{favoriteModel}</b></div>
      </div>

      <h4 className="subhead">{t('Daily activity · last 26 weeks')}</h4>
      <div className="cal-months">{monthLabels.map((m, i) => <span key={i}>{m}</span>)}</div>
      <div className="calwrap">
        <div className="cal-days">{calDayLabels.map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="cal">
          {calColumns.map((col, w) => col.map((cell, d) => (
            <i key={`${w}-${d}`} className={level(cell.count, calMax) ? `l${level(cell.count, calMax)}` : ''}
              title={`${cell.date} · ${cell.count}`} />
          )))}
        </div>
      </div>

      <h4 className="subhead" style={{ marginTop: 16 }}>{t('By hour of day · 30d')}</h4>
      <div className="heat">
        {ROW_DOWS.map((dow, r) => (
          <React.Fragment key={dow}>
            <span className="rl">{rowLabels[r]}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const count = hourByCell.get(`${dow}:${hour}`) ?? 0;
              const lvl = level(count, hourMax);
              return <i key={hour} className={`c${lvl ? ` h${lvl}` : ''}`} title={`${rowLabels[r]} ${hour}:00 · ${count}`} />;
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="hour-axis"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
      <div className="heat-legend">
        0
        <i style={{ background: 'var(--bg2)' }} />
        <i className="h1" /><i className="h2" /><i className="h3" /><i className="h4" /><i className="h5" />
        {' '}{t('messages per hour-slot · 30d (weighted by message count)')}
      </div>

      <div className="fun">
        {t("You've used ~{n}× more tokens than the complete works of Shakespeare.").replace('{n}', String(shakespeare))}
      </div>
    </div>
  );
}
