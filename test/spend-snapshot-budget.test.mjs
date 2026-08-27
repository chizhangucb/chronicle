// CHI-366: the briefing budget slice must price a LANE-C-FREE costed-day series
// so the server month-to-date matches the Spend tab's budget band (which reads
// `insights.dailySpend` = bucketedUsage only; Lane C is a separate field there).
// If the budget reused the anomaly series (Lane C folded into the day total),
// the server budget would read higher than the client by the proxy total — the
// exact disagreement CHI-366 is meant to prevent. These pin the fold behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costedDaysFromBurn } from '../server/spendSnapshot.ts';

// A minimal ActivityBurn with empty per-model cells (so token pricing is $0) and
// a Lane C entry — this isolates the Lane-C fold: cost == laneC when included, 0
// when excluded. Only the fields costedDaysFromBurn reads are populated.
function burnWith(laneCByDay) {
  return {
    anomalyDays: [{ day: '2026-08-10', byModel: {}, byProject: {}, bySource: {} }],
    laneCByDay,
  };
}

test('costedDaysFromBurn: Lane C folds into the day total by default (anomaly reading, D8)', () => {
  const days = costedDaysFromBurn(burnWith({ '2026-08-10': 7 }));
  assert.equal(days[0].cost, 7);
});

test('costedDaysFromBurn: Lane-C-free when includeLaneC=false (budget slice matches Spend tab MTD)', () => {
  const days = costedDaysFromBurn(burnWith({ '2026-08-10': 7 }), false);
  assert.equal(days[0].cost, 0);
});
