// Route golden (ticket #304): every engine's JSON, on one deterministic
// corpus, pinned against the pre-slice commit (`main` at 15d1589). The
// consolidation onto one query context is behaviour-preserving by intent, so
// equality with the fixture IS the assertion — every engine except activity's
// baseline, which this slice fixes on purpose (excluded here, pinned by
// test/activity-baseline-local-days.test.mjs instead).
//
// The fixture was captured by running the same corpus and the same range/scope
// matrix against the pre-slice engines; see test/helpers/golden-corpus.mjs for
// how run-day dates are normalized so a fixture captured once stays valid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { withTempDb } from './helpers.mjs';
import { anchorNow, buildCorpus, normalizeGolden } from './helpers/golden-corpus.mjs';

const GOLDEN = JSON.parse(fs.readFileSync(new URL('./fixtures/route-golden.json', import.meta.url), 'utf8'));

let teardown, actual, server;

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  const now = anchorNow();
  const { alpha } = buildCorpus(temp.dbModule, now);

  const { computeInsights } = await import('../server/insights.ts');
  const { computeExplore } = await import('../server/explore.ts');
  const { computeContent } = await import('../server/content.ts');
  const { computeActivity } = await import('../server/activity.ts');
  const { computeDetectors } = await import('../server/detectors.ts');
  const { computeWaste } = await import('../server/waste.ts');
  const { rangeOf } = await import('../server/scope.ts');
  const { mountProjects } = await import('../server/routes/projects.ts');
  const { mountSessions } = await import('../server/routes/sessions.ts');

  const ALL = { type: 'all' };
  const out = {};
  for (const days of [1, 7, null]) {
    const range = rangeOf(days, now);
    out[`insights:${days}`] = await computeInsights(ALL, range);
    const a = computeActivity(ALL, range, null);
    delete a.burn.baselineTokensByModel; // the one intended change — see the header
    out[`activity:${days}`] = a;
    out[`detectors:${days}`] = computeDetectors(ALL, range);
    out[`waste:${days}`] = computeWaste(ALL, range);
  }
  for (const scope of [ALL, { type: 'project', id: alpha.id }, { type: 'session', id: 'g-today' }]) {
    out[`content:${scope.type}:7`] = computeContent(scope, rangeOf(7, now));
    out[`content:${scope.type}:all`] = computeContent(scope, rangeOf(null, now));
  }
  const exploreCases = [
    { metric: 'spend', group: 'model', rollup: 'total', days: 7, topN: 10 },
    { metric: 'tokens', group: 'session', rollup: 'daily', days: 7, topN: 5 },
    { metric: 'errors', group: 'tool', rollup: 'total', days: 30, topN: 10 },
    { metric: 'requests', group: 'project', rollup: 'weekly', days: null, topN: 10 },
    { metric: 'active', group: 'source', rollup: 'hourly', days: 1, topN: 10 },
  ];
  for (const c of exploreCases) {
    const { days, ...rest } = c;
    const key = `${c.metric}:${c.group}:${c.rollup}:${days}`;
    out[`explore:${key}`] = computeExplore({ scope: ALL, range: rangeOf(days, now), ...rest });
    out[`explore-proj:${key}`] = computeExplore({ scope: { type: 'project', id: alpha.id }, range: rangeOf(days, now), ...rest });
  }

  const app = express();
  mountProjects(app);
  mountSessions(app);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const days of [7, null]) {
    out[`project:${days}`] = await (await fetch(`${base}/projects/${alpha.id}${days ? `?days=${days}` : ''}`)).json();
  }

  out['sessions-minor'] = await (await fetch(`${base}/sessions/minor`)).json();
  for (const id of ['g-today', 'g-span']) {
    out[`messages:${id}`] = await (await fetch(`${base}/sessions/${id}/messages`)).json();
  }

  actual = normalizeGolden(out, now);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  teardown?.();
});

for (const key of Object.keys(GOLDEN)) {
  test(`route golden: ${key} is unchanged by the query-context consolidation`, () => {
    assert.deepEqual(actual[key], GOLDEN[key]);
  });
}
