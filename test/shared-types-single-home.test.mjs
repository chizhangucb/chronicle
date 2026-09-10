// Row and result types have one home in shared/ (issue #307, part of #294).
//
// The client used to retype every server row and engine result by hand:
// src/api.ts mirrored server/db.ts's SessionRow/MessageRow and every engine's
// result shape, and SessionView.tsx kept a third copy of the session payload.
// Each shape now has exactly one declaration, under shared/, that the server
// and the client both import.
//
// The behaviour of the routes themselves is pinned by test/route-golden.test.mjs;
// this file pins only that there is nowhere for a second copy to live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared')]
  .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

// name → the one file allowed to declare it. A `interface X`/`type X =`
// binding anywhere else is the hand-typed mirror coming back.
const ROW_TYPES = [
  { name: 'SessionRow', home: 'shared/rows.ts' },
  { name: 'MessageRow', home: 'shared/rows.ts' },
  { name: 'InsightsSessionRow', home: 'shared/rows.ts' },
  { name: 'ProjectSessionSummary', home: 'shared/rows.ts' },
  { name: 'MinorSessionRow', home: 'shared/rows.ts' },
  { name: 'SearchResultItem', home: 'shared/rows.ts' },
  { name: 'ToolCount', home: 'shared/rows.ts' },
  { name: 'KindCount', home: 'shared/rows.ts' },
  { name: 'DayCount', home: 'shared/rows.ts' },
  { name: 'Commit', home: 'shared/rows.ts' },
  { name: 'RepoInfo', home: 'shared/rows.ts' },
];

// Where a name can be reached from: a declaration, or a re-export, which is a
// second home wearing the first one's clothes (a module that re-exports a
// shared type gives a caller two spellings of the same import).
function declarationsOf(name) {
  return SOURCES
    .filter(({ text }) => new RegExp(`(?:^|\\n)\\s*(?:export )?(?:interface ${name}\\b|type ${name}\\b\\s*=)`).test(text)
      || new RegExp(`export type \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(text))
    .map(({ rel }) => rel);
}

test('every row type is declared exactly once, in shared/', () => {
  for (const { name, home } of ROW_TYPES) {
    assert.deepEqual(declarationsOf(name), [home], `${name} should be declared only in ${home}`);
  }
});

// The engine results: one declaration each, in shared/results.ts (Explore's
// frozen wire dialect lives in shared/explore.ts, beside the vocabularies it
// shares with the engine).
const RESULT_TYPES = [
  { name: 'InsightsResult', home: 'shared/results.ts' },
  { name: 'ScopedAggregates', home: 'shared/results.ts' },
  { name: 'ProjectDetailResult', home: 'shared/results.ts' },
  { name: 'ProjectListItem', home: 'shared/results.ts' },
  { name: 'SessionMessagesResult', home: 'shared/results.ts' },
  { name: 'ActivityResult', home: 'shared/results.ts' },
  { name: 'ActivityBurn', home: 'shared/results.ts' },
  { name: 'ContentResult', home: 'shared/results.ts' },
  { name: 'Characteristic', home: 'shared/results.ts' },
  { name: 'DetectorCounts', home: 'shared/results.ts' },
  { name: 'WasteResult', home: 'shared/results.ts' },
  { name: 'SearchResponse', home: 'shared/results.ts' },
  { name: 'Settings', home: 'shared/results.ts' },
  { name: 'PlanWindowsResult', home: 'shared/results.ts' },
  { name: 'SecurityScanResult', home: 'shared/results.ts' },
  { name: 'ImportResult', home: 'shared/results.ts' },
  { name: 'AskTurn', home: 'shared/results.ts' },
  { name: 'AskCostMode', home: 'shared/results.ts' },
  { name: 'RangeUsageCell', home: 'shared/usage.ts' },
  { name: 'BucketedUsageCell', home: 'shared/usage.ts' },
  { name: 'ExploreWireResult', home: 'shared/explore.ts' },
  { name: 'ExploreWireRow', home: 'shared/explore.ts' },
  { name: 'ExploreWireCell', home: 'shared/explore.ts' },
  { name: 'ExploreQueryParams', home: 'shared/explore.ts' },
];

test('every engine result type is declared exactly once, in shared/', () => {
  for (const { name, home } of RESULT_TYPES) {
    assert.deepEqual(declarationsOf(name), [home], `${name} should be declared only in ${home}`);
  }
});

test('both sides import the shared homes', () => {
  // The engine that computes a result and the surface that renders it read the
  // same file: a shared/ home with only server importers (or only client ones)
  // would be a move, not a consolidation.
  for (const home of ['shared/rows.ts', 'shared/results.ts', 'shared/explore.ts']) {
    const importers = SOURCES.filter(({ rel, text }) => rel !== home && new RegExp(`from '[^']*${path.basename(home)}'`).test(text));
    assert.ok(importers.some(({ rel }) => rel.startsWith('server/')), `${home} has no server importer`);
    assert.ok(importers.some(({ rel }) => rel.startsWith('src/')), `${home} has no client importer`);
  }
});

// ---- The client fetch module ----

const API = SOURCES.find(({ rel }) => rel === 'src/api.ts').text;

test('src/api.ts is the fetch layer and nothing else', () => {
  // No response shape is declared here any more: it declares the fetch
  // helper, the URL builders and the `api` object, and imports every shape.
  const declared = [...API.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(declared, [], 'response shapes belong in shared/, not in the fetch module');
});

test('every export of the fetch module has an importer', () => {
  const exported = [...API.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  assert.ok(exported.length > 0);
  for (const name of exported) {
    // An importer, not a mention: the name has to arrive through an import of
    // the module, not appear in someone's comment.
    const importers = SOURCES
      .filter(({ rel, text }) => rel !== 'src/api.ts'
        && new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[^']*api\\.(?:js|ts)'`, 's').test(text))
      .map(({ rel }) => rel);
    assert.notDeepEqual(importers, [], `api.ts exports ${name} with no importer`);
  }
});

test('no component fetches on its own', () => {
  // Every read and write goes through the fetch module, so the write token,
  // the 403 retry and the error-message extraction are applied once.
  // src/writeToken.ts is the one exception: it is what fetches the token that
  // src/api.ts attaches, so it cannot route through it.
  const callers = SOURCES
    .filter(({ rel }) => rel.startsWith('src/') && rel !== 'src/api.ts' && rel !== 'src/writeToken.ts')
    .filter(({ text }) => /(?<![.\w])fetch\(/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(callers, []);
});

// ---- One import convention for shared/ ----

test('shared/ is imported by relative path everywhere, and the alias is gone', () => {
  for (const { rel, text } of SOURCES) {
    assert.ok(!text.includes('@shared'), `${rel} still mentions the @shared alias`);
  }
  for (const rel of ['vite.config.js', 'tsconfig.client.json']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(!text.includes('@shared'), `${rel} still wires the @shared alias`);
  }
  for (const rel of ['docs/contributing.md', 'docs/contributing/patterns.md', 'docs/contributing/code-map.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(!text.includes('@shared'), `${rel} still documents the @shared alias`);
  }
});
