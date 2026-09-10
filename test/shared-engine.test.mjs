// One engine behind Insights and the project page (ticket #305).
//
// The property under test is the operator-facing one from the spec: Insights
// scoped to one project and that project's page report the SAME aggregates for
// the SAME sessions, because they run the same engine. So the assertions
// compare the project route's JSON against the Insights engine called with a
// project scope — not against a hand-written expectation of either.
//
// Same deterministic corpus as test/query-context-golden.test.mjs (see
// test/helpers/golden-corpus.mjs for why the anchor is local noon on the most
// recent Monday). The ranges are 30d and All: the project route derives its own
// range from the real clock, so a short range would be sensitive to how far the
// anchor sits from now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withTempDb } from './helpers.mjs';
import { anchorNow, buildCorpus } from './helpers/golden-corpus.mjs';

let teardown, server, baseUrl, alpha, beta, insights, rangeOf, dbModule, now;

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  dbModule = temp.dbModule;
  now = anchorNow();
  const corpus = buildCorpus(temp.dbModule, now);
  alpha = corpus.alpha;
  beta = corpus.beta;

  insights = await import('../server/insights.ts');
  ({ rangeOf } = await import('../server/scope.ts'));
  const { mountProjects } = await import('../server/routes/projects.ts');
  const app = express();
  mountProjects(app);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  teardown?.();
});

const projectPage = async (id, days) =>
  (await fetch(`${baseUrl}/projects/${id}${days ? `?days=${days}` : ''}`)).json();

// The route's half of every comparison has been through JSON; node:sqlite hands
// the engine null-prototype rows. Round-trip the engine's side so the
// comparison is about the numbers, not about how a row was constructed.
const wire = (v) => JSON.parse(JSON.stringify(v));

for (const days of [30, null]) {
  test(`the project page's aggregates are the Insights engine's, scoped to that project (${days ?? 'all'})`, async () => {
    const page = await projectPage(alpha.id, days);
    const scoped = wire(insights.computeScopedAggregates({ type: 'project', id: alpha.id }, rangeOf(days)));
    assert.deepEqual(page.analytics.toolDist, scoped.toolDist);
    assert.deepEqual(page.analytics.kindDist, scoped.kindDist);
    assert.deepEqual(page.analytics.activity, scoped.activity);
    assert.equal(page.analytics.errors, scoped.errors);
    assert.deepEqual(page.analytics.rangedTokensByModel, scoped.rangedTokensByModel);
  });
}

test('the scoped aggregates narrow to their project: alpha and beta disagree', () => {
  const range = rangeOf(null);
  const a = insights.computeScopedAggregates({ type: 'project', id: alpha.id }, range);
  const b = insights.computeScopedAggregates({ type: 'project', id: beta.id }, range);
  const all = insights.computeScopedAggregates({ type: 'all' }, range);
  const kinds = (r) => Object.fromEntries(r.kindDist.map((k) => [k.kind, k.count]));
  assert.notDeepEqual(kinds(a), kinds(b));
  // Every kind counted at 'all' scope is the two projects' counts added up.
  for (const kind of new Set([...Object.keys(kinds(a)), ...Object.keys(kinds(b))])) {
    assert.equal(kinds(all)[kind], (kinds(a)[kind] ?? 0) + (kinds(b)[kind] ?? 0), kind);
  }
  // The noise-gated session (g-minor, on alpha) stays out of both.
  assert.equal(a.rangedTokensByModel.some((c) => c.sessionId === 'g-minor'), false);
  assert.equal(all.rangedTokensByModel.some((c) => c.sessionId === 'g-minor'), false);
});

// Records the SQL of every statement prepared while `fn` runs, so a test can
// ask how many times an aggregate was actually computed. The engine and the
// test share one DatabaseSync (see test/helpers.mjs), so shadowing `prepare`
// on it is what the engine calls.
async function preparedDuring(fn) {
  const had = Object.prototype.hasOwnProperty.call(dbModule.db, 'prepare');
  const original = dbModule.db.prepare;
  const real = original.bind(dbModule.db);
  const sql = [];
  dbModule.db.prepare = (text) => { sql.push(text); return real(text); };
  try {
    return { sql, value: await fn() };
  } finally {
    if (had) dbModule.db.prepare = original; else delete dbModule.db.prepare;
  }
}

// The day-bucketed billed cells (server/rangeUsage.ts bucketedUsage, 'day')
// and their hour-bucketed sibling, told apart by their bucket key expression.
const DAY_BUCKETED_USAGE = /CASE WHEN m\.ts >= \? THEN strftime\('%Y-%m-%d', m\.ts, 'localtime'\)/;
const HOUR_BUCKETED_USAGE = /CASE WHEN m\.ts >= \? THEN strftime\('%Y-%m-%dT%H', m\.ts, 'localtime'\)/;
const count = (sql, re) => sql.filter((text) => re.test(text)).length;

test('Insights computes bucketed usage once per bucket, not twice', async () => {
  // Today: the one range that also asks for the hour buckets, so both
  // granularities are on the table and each must be computed exactly once.
  const { sql, value } = await preparedDuring(() => insights.computeInsights({ type: 'all' }, rangeOf(1, now)));
  assert.equal(count(sql, DAY_BUCKETED_USAGE), 1, 'the day-bucketed usage query ran more than once');
  assert.equal(count(sql, HOUR_BUCKETED_USAGE), 1, 'the hour-bucketed usage query ran more than once');
  // dailySpend is the ranged cells under the contract's second name — the same
  // cells, not a second computation of them.
  assert.deepEqual(value.dailySpend, value.rangedTokensByModel);
  assert.ok(value.rangedTokensByModel.length > 0, 'the corpus should bill something inside Today');
});

test('Insights skips the hour buckets outside a short range', async () => {
  const { sql, value } = await preparedDuring(() => insights.computeInsights({ type: 'all' }, rangeOf(30, now)));
  assert.equal(count(sql, DAY_BUCKETED_USAGE), 1);
  assert.equal(count(sql, HOUR_BUCKETED_USAGE), 0);
  assert.equal(value.hourlySpend, null);
});
