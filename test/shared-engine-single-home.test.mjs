// Structural pins for ticket #305: the Insights engine is the ONE home for
// the four scoped aggregates, and the project route keeps only its session
// list and its Git data.
//
// These read the tracked sources (like test/query-context-single-home.test.mjs
// and test/repo-shape.test.mjs) because the property under test is "written
// once", which no single route's output can show: two copies of the same query
// agree until one of them is edited. The copies this slice deleted were plain
// SQL in server/routes/projects.ts, easy to reintroduce by paste, so they trip
// CI instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, tracked } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';

const read = (rel) => readSource(path.join(REPO, rel));
const SERVER_TS = tracked.filter((rel) => rel.startsWith('server/') && rel.endsWith('.ts'));

// The engine, and the ranged-usage primitive it composes.
const ENGINE = 'server/insights.ts';
const USAGE_PRIMITIVE = 'server/rangeUsage.ts';
const PROJECT_ROUTE = 'server/routes/projects.ts';

// Each aggregate, spelled as the SQL that computes it, with the files allowed
// to spell it. If one ever matches another file, that surface has grown its own
// copy again. Explore keeps its own error sum on purpose: it groups by tool,
// project or source with its own bucketing (#306), which is a different
// question from "how many errors did these sessions hit".
const AGGREGATES = [
  ['tool distribution', /m\.tool_name AS name/, [ENGINE]],
  ['kind distribution', /m\.kind AS kind, COUNT/, [ENGINE]],
  ['activity', /strftime\('%Y-%m-%d', m\.ts, 'localtime'\) AS day/, [ENGINE]],
  ['errors', /SUM\(COALESCE\(s\.error_count/, [ENGINE, 'server/explore.ts']],
];

for (const [name, sql, homes] of AGGREGATES) {
  test(`${name} is computed in one place, the Insights engine`, () => {
    const found = SERVER_TS.filter((rel) => sql.test(read(rel)));
    assert.deepEqual(found.slice().sort(), homes.slice().sort(), `${name} is written outside ${homes.join(' / ')}`);
  });
}

test('the project route runs no aggregate query of its own', () => {
  const src = read(PROJECT_ROUTE);
  assert.doesNotMatch(src, /CROSS JOIN messages/, 'the project route joins messages for an aggregate again');
  assert.doesNotMatch(src, /strftime\(/, 'the project route buckets by day again');
  assert.doesNotMatch(src, /error_count/, 'the project route reads the error columns again');
  assert.doesNotMatch(src, /bucketedUsage\(/, 'the project route calls the usage primitive directly again');
});

// The route's numbers are pinned behaviourally in test/shared-engine.test.mjs;
// what this adds is the import itself, so "the project page runs the engine"
// cannot be quietly undone by pasting the queries back.
test('the project route takes its analytics from the engine', () => {
  assert.match(read(PROJECT_ROUTE), /from '\.\.\/insights\.ts'/, 'the project route no longer reaches the Insights engine');
});

test('bucketed usage is reached through the engine, not from a route', () => {
  const routeCallers = tracked
    .filter((rel) => rel.startsWith('server/routes/') && rel.endsWith('.ts'))
    .filter((rel) => /bucketedUsage/.test(read(rel)));
  assert.deepEqual(routeCallers, [], 'a route calls bucketedUsage directly instead of asking an engine');
  // The primitive itself, plus the engines that bucket: Insights, activity and
  // Explore. Not a list that should grow without a reason.
  const callers = SERVER_TS.filter((rel) => /bucketedUsage/.test(read(rel)));
  assert.deepEqual(callers.slice().sort(), [
    'server/activity.ts', 'server/explore.ts', ENGINE, USAGE_PRIMITIVE,
  ].sort());
});
