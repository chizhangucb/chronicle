// Unit tests for the ported shared spend math (CHI-324 2a): anomaly detection
// (shared/spend/anomaly.ts, ported from Varde computeAnomaly) and budget
// posture (shared/spend/budget.ts). Both are pure over already-costed day
// series; these assert the algorithm, not pricing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnomaly, computeFlaggedDays } from '../shared/spend/anomaly.ts';
import { computeBudgetPosture } from '../shared/spend/budget.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';

// 14 prior active days at $10, then a $30 today = 3x the median → flagged +
// escalated (default multiplier 1.75, escalation 3).
function priorDays(n, cost, startDay = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = String(startDay + i).padStart(2, '0');
    out.push({ day: `2026-08-${d}`, cost });
  }
  return out;
}

test('computeAnomaly: baseline = median of trailing active days strictly before today', () => {
  const days = [...priorDays(14, 10, 1), { day: '2026-08-20', cost: 30 }];
  const a = computeAnomaly(days, '2026-08-20');
  assert.equal(a.baselineMedian, 10);
  assert.equal(a.todayCost, 30);
  assert.equal(a.ratio, 3);
  assert.equal(a.flagged, true);
  assert.equal(a.escalated, false); // 3 is not > 3 (escalation is strict)
});

test('computeAnomaly: a 4x day escalates', () => {
  const days = [...priorDays(14, 10, 1), { day: '2026-08-20', cost: 40 }];
  const a = computeAnomaly(days, '2026-08-20');
  assert.equal(a.ratio, 4);
  assert.equal(a.flagged, true);
  assert.equal(a.escalated, true);
});

test('computeAnomaly: no prior active days → null baseline, not flagged', () => {
  const a = computeAnomaly([{ day: '2026-08-20', cost: 30 }], '2026-08-20');
  assert.equal(a.baselineMedian, null);
  assert.equal(a.ratio, null);
  assert.equal(a.flagged, false);
});

test('computeAnomaly: zero-cost prior days are excluded from the baseline', () => {
  const days = [
    { day: '2026-08-01', cost: 0 },
    { day: '2026-08-02', cost: 0 },
    { day: '2026-08-03', cost: 10 },
    { day: '2026-08-20', cost: 30 },
  ];
  const a = computeAnomaly(days, '2026-08-20');
  assert.equal(a.baselineMedian, 10); // only the one active prior day
  assert.equal(a.ratio, 3);
});

test('computeAnomaly: a dimension value above the $1 floor and >1.75x its own median flags as a mover', () => {
  const mk = (day, total, projA) => ({ day, cost: total, byDimension: { project: { 'proj-a': projA } } });
  const days = [
    mk('2026-08-01', 10, 5),
    mk('2026-08-02', 10, 5),
    mk('2026-08-03', 10, 5),
    mk('2026-08-20', 30, 20), // proj-a 20 vs median 5 = 4x
  ];
  const a = computeAnomaly(days, '2026-08-20');
  assert.equal(a.dimensionFlags.length, 1);
  assert.equal(a.dimensionFlags[0].dimension, 'project');
  assert.equal(a.dimensionFlags[0].value, 'proj-a');
  assert.equal(a.dimensionFlags[0].ratio, 4);
});

test('computeAnomaly: a sub-$1 dimension value never flags (noise floor)', () => {
  const mk = (day, projA) => ({ day, cost: projA, byDimension: { project: { 'proj-a': projA } } });
  const days = [mk('2026-08-01', 0.1), mk('2026-08-02', 0.1), mk('2026-08-20', 0.9)];
  const a = computeAnomaly(days, '2026-08-20');
  assert.equal(a.dimensionFlags.length, 0);
});

test('computeFlaggedDays: a prior spike day flags vs its own trailing median, newest first', () => {
  const days = [...priorDays(14, 10, 1), { day: '2026-08-18', cost: 30 }, { day: '2026-08-19', cost: 10 }, { day: '2026-08-20', cost: 12 }];
  const flags = computeFlaggedDays(days, '2026-08-20'); // today (08-20) is the headline, excluded
  assert.equal(flags.length, 1);
  assert.equal(flags[0].day, '2026-08-18'); // 30 vs a 10 median = 3x
  assert.equal(flags[0].ratio, 3);
});

test('computeFlaggedDays: today is never counted as a flagged window day', () => {
  const days = [...priorDays(14, 10, 1), { day: '2026-08-20', cost: 40 }];
  assert.equal(computeFlaggedDays(days, '2026-08-20').length, 0);
});

test('computeFlaggedDays: sinceDay bounds which days are reported, not the median lookback', () => {
  const days = [...priorDays(14, 10, 1), { day: '2026-08-16', cost: 30 }, { day: '2026-08-19', cost: 30 }, { day: '2026-08-20', cost: 10 }];
  // Both 08-16 and 08-19 are 3x spikes, but only report from 08-18 onward.
  const flags = computeFlaggedDays(days, '2026-08-20', DEFAULT_SPEND_THRESHOLDS.anomaly, '2026-08-18');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].day, '2026-08-19');
});

test('computeBudgetPosture: pace + projection + share + state', () => {
  // Aug has 31 days. 10 elapsed days at $5/day = $50 MTD; pace $5/day; projected $155.
  const days = priorDays(10, 5, 1); // 2026-08-01..10
  const b = computeBudgetPosture(days, '2026-08-10', 200);
  assert.equal(b.monthToDate, 50);
  assert.equal(b.elapsedDays, 10);
  assert.equal(b.daysInMonth, 31);
  assert.equal(b.perDayPace, 5);
  assert.equal(b.projected, 155);
  assert.equal(b.share, 0.25);
  assert.equal(b.state.word, 'on track');
});

test('computeBudgetPosture: over budget grades danger', () => {
  const days = priorDays(10, 25, 1); // $250 MTD
  const b = computeBudgetPosture(days, '2026-08-10', 200);
  assert.equal(b.monthToDate, 250);
  assert.equal(b.share, 1.25);
  assert.equal(b.state.word, 'over budget');
  assert.equal(b.state.severity, 'danger');
});

test('computeBudgetPosture: no budget set → null share/state, still reports MTD + pace', () => {
  const days = priorDays(10, 5, 1);
  const b = computeBudgetPosture(days, '2026-08-10', null);
  assert.equal(b.monthlyUsd, null);
  assert.equal(b.share, null);
  assert.equal(b.state, null);
  assert.equal(b.monthToDate, 50);
  assert.equal(b.perDayPace, 5);
});

test('computeBudgetPosture: under 3 elapsed days suppresses the projection (noise)', () => {
  const days = priorDays(2, 5, 1);
  const b = computeBudgetPosture(days, '2026-08-02', 200);
  assert.equal(b.projected, null);
  assert.equal(b.elapsedDays, 2);
});

test('computeBudgetPosture: only the current month counts toward MTD', () => {
  const days = [
    { day: '2026-07-31', cost: 100 }, // prior month, excluded
    { day: '2026-08-01', cost: 5 },
    { day: '2026-08-02', cost: 5 },
    { day: '2026-08-03', cost: 5 },
  ];
  const b = computeBudgetPosture(days, '2026-08-03', 200);
  assert.equal(b.monthToDate, 15);
});
