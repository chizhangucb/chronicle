// Structural pins for ticket #304: the query context is the ONE home for the
// scope clause, the minor gate and the range.
//
// These read the tracked sources (like test/repo-shape.test.mjs) because the
// property under test is "written once", which no single engine's output can
// show. The 37 hand-written `COALESCE(s.minor,0)=0` gates and the engines'
// bare `days: number | null` parameters are what this slice removed; both are
// easy to reintroduce by copy-paste, so they trip CI instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tracked } from './helpers/tracked-files.mjs';

const SERVER_TS = tracked.filter((rel) => rel.startsWith('server/') && rel.endsWith('.ts'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// The one module allowed to spell the gate out.
const QUERY_CONTEXT = 'server/scope.ts';

test('the minor gate is written once, in the query-context module', () => {
  const offenders = SERVER_TS
    .filter((rel) => rel !== QUERY_CONTEXT)
    .filter((rel) => /COALESCE\(\s*(\w+\.)?minor\s*,\s*0\s*\)\s*=\s*0/i.test(read(rel)));
  assert.deepEqual(offenders, [], 'these files hand-write the minor gate instead of taking it from server/scope.ts');
});

// Every analytics engine, including the detectors and waste ones that used to
// take a bare day count.
const ENGINES = [
  ['server/insights.ts', 'computeInsights'],
  ['server/activity.ts', 'computeActivity'],
  ['server/content.ts', 'computeContent'],
  ['server/explore.ts', 'computeExplore'],
  ['server/detectors.ts', 'computeDetectors'],
  ['server/waste.ts', 'computeWaste'],
];

for (const [rel, fn] of ENGINES) {
  test(`${fn} takes a scope and a range, never a bare day count`, () => {
    const src = read(rel);
    const signature = new RegExp(`export function ${fn}\\(([^)]*)\\)`).exec(src)
      ?? new RegExp(`export async function ${fn}\\(([^)]*)\\)`).exec(src);
    assert.ok(signature, `${rel} exports ${fn}`);
    const params = signature[1];
    assert.match(params, /Scope|ExploreQuery/, `${fn} takes a scope`);
    assert.match(params, /Range|ExploreQuery/, `${fn} takes a range`);
    assert.doesNotMatch(params, /days\s*:\s*number/, `${fn} still takes a bare day count`);
  });
}

test('the Explore query carries a range, not a day count', () => {
  const src = read('server/explore.ts');
  const query = /export interface ExploreQuery \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(query, 'server/explore.ts declares ExploreQuery');
  assert.match(query[1], /range: Range/);
  assert.doesNotMatch(query[1], /days\s*:\s*number/);
});
