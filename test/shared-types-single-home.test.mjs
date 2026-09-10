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

// ---- The surfaces that render a shared shape ----

// #307 moved the shapes to shared/ but left five hand-typed copies standing in
// the surfaces that render them (issue #345). Each was a LOSSY copy: it kept
// the fields its own JSX happened to read and dropped the rest, so the surface
// could not reach a field the route had been answering with all along
// (SearchResult dropped `seq`, `message_count`, `usage` and `agent_active_ms`;
// MinorSession dropped `started_at`). A surface reads the shared home now.
const SURFACES = [
  { rel: 'src/SearchModal.tsx', reads: [['SearchResponse', 'shared/results.ts'], ['ProjectListItem', 'shared/results.ts']] },
  { rel: 'src/RecentLedger.tsx', reads: [['MinorSessionRow', 'shared/rows.ts']] },
  { rel: 'server/routes/ask.ts', reads: [['AskTurn', 'shared/results.ts']] },
];

test('each surface imports the shape it renders from the shared home', () => {
  for (const { rel, reads } of SURFACES) {
    const text = SOURCES.find((s) => s.rel === rel).text;
    for (const [name, home] of reads) {
      const pattern = new RegExp(`import type \\{[^}]*\\b${name}\\b[^}]*\\} from '[^']*${path.basename(home)}'`, 's');
      assert.match(text, pattern, `${rel} should import ${name} from ${home}`);
    }
  }
});

// The mirrors' own names, which is what a reinstated copy would be called.
// `MinorSessionRow`/`SearchResultItem` are the shared shapes and keep their
// names: the word boundary is what tells the copy from the home.
const MIRROR_NAMES = ['SearchResult', 'SearchData', 'SearchProject', 'MinorSession'];

test('the hand-typed mirrors of the shared shapes are gone', () => {
  for (const name of MIRROR_NAMES) {
    const hits = SOURCES.filter(({ text }) => new RegExp(`\\b${name}\\b`).test(text)).map(({ rel }) => rel);
    assert.deepEqual(hits, [], `${name} was a hand-typed mirror and should not come back`);
  }
});

// ---- The structural half of the pin ----

// Matching by NAME alone is how the five mirrors above escaped this file:
// `SearchData` is `SearchResponse` retyped under another name, so no name in
// the tables ever collided. The pin below reads the DECLARED FIELD SET — each
// field's name, its optionality and its declared type — so a copy fails it
// whatever it is called.
//
// A copy retypes the shapes it references too (`SearchData.results` was
// `SearchResult[]`, the local copy of `SearchResultItem`), so a reference to a
// pinned shape and a reference to a shape declared in the copy's own file both
// normalize to one placeholder: that substitution is the whole of what a
// rename can hide. Everything else has to match literally, which is what keeps
// the deliberate dialects apart from the copies — server/detectors.ts's
// `CountRow` reads `number | null` off SQLite where `DetectorCounts` promises
// `number`, server/config.ts's `ChronicleConfig` is the all-optional stored
// form of `Settings`, and server/explore.ts's `ExploreRow` carries `UsageCell`
// where the wire carries `ExploreWireCell`.
//
// It reads a LITERAL copy: a lossy one (SearchResult dropped four fields) is
// not the same field set and only the name tables catch it.
const PINNED = [...ROW_TYPES, ...RESULT_TYPES].map(({ name }) => name);

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Split an interface body into members: `;` and `,` at brace/paren/generic
// depth 0. A `=>` is not a closing generic, so a function-typed field stays in
// one piece.
function members(body) {
  const out = [];
  let buf = '', depth = 0, prev = '';
  for (const ch of body) {
    if ('{(['.includes(ch) || ch === '<') depth++;
    else if ('})]'.includes(ch) || (ch === '>' && prev !== '=')) depth--;
    if (depth === 0 && (ch === ';' || ch === ',')) { out.push(buf); buf = ''; prev = ch; continue; }
    buf += ch; prev = ch;
  }
  out.push(buf);
  return out;
}

/** Every object shape a file declares: `interface X { … }` and `type X = { … }`,
 * with the fields each one declares itself (an `extends` clause contributes
 * nothing — the pin reads what is written here). */
function shapesOf(rel, text) {
  const out = [];
  const re = /(?:^|\n)\s*(?:export\s+)?(?:interface\s+(\w+)|type\s+(\w+)\s*=\s*(?=\{))/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', re.lastIndex - 1);
    // `interface X extends Y {`: only the heritage clause may sit in between.
    if (open < 0 || /[;=)]/.test(text.slice(re.lastIndex, open))) continue;
    let depth = 0, end = open;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    const fields = members(stripComments(text.slice(open + 1, end)))
      .map((member) => /^\s*(?:readonly\s+)?(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(member))
      .filter(Boolean)
      .map(([, name, optional, type]) => ({ name, optional: !!optional, type: type.replace(/\s+/g, ' ').trim() }));
    out.push({ rel, name: m[1] || m[2], fields });
  }
  return out;
}

/** The declared field set, as one comparable string. Type names that a rename
 * could swap — a pinned shape, or a shape declared in the same file — collapse
 * to a placeholder; every other name is compared as written. */
function fieldSet(shape, siblings) {
  const placeholder = (type) => type.replace(/\b[A-Z]\w*\b/g, (id) => (PINNED.includes(id) || siblings.has(id) ? '«shape»' : id));
  return shape.fields
    .map(({ name, optional, type }) => `${name}${optional ? '?' : ''}: ${placeholder(type)}`)
    .sort()
    .join('; ');
}

/** Declarations outside shared/ that carry a pinned shape's field set — the
 * copy that a name table cannot see. */
function structuralCopies(sources) {
  const shapes = sources.flatMap(({ rel, text }) => shapesOf(rel, text));
  const siblingsOf = (rel) => new Set(shapes.filter((s) => s.rel === rel).map((s) => s.name));
  // A shape with a single field says too little to identify a copy by.
  const named = shapes.filter((s) => s.fields.length > 1);
  const homes = named.filter((s) => s.rel.startsWith('shared/') && PINNED.includes(s.name));
  const copies = [];
  for (const home of homes) {
    const sig = fieldSet(home, siblingsOf(home.rel));
    for (const candidate of named) {
      // shared/ is the home region: two shared shapes that coincide (rates per
      // MTok and token counts are both five numbers) each keep one home, which
      // the name tables above already pin. A copy lives outside it.
      if (candidate.rel.startsWith('shared/')) continue;
      if (fieldSet(candidate, siblingsOf(candidate.rel)) === sig) {
        copies.push(`${candidate.rel} declares ${candidate.name}, the field set of ${home.name} (${home.rel})`);
      }
    }
  }
  return copies;
}

test('no shared shape is declared a second time under another name', () => {
  assert.deepEqual(structuralCopies(SOURCES), []);
});

test('a renamed copy of a shared shape fails the pin', () => {
  // The pin has to bite on the case it exists for, or it passes by reading
  // nothing: `SearchData`, the mirror this file used to miss, retyped once more.
  const copy = `
    interface SearchHit {
      id: string;
      project_id: number;
      source: string;
      name: string | null;
      summary: string | null;
      first_prompt: string | null;
      project_name: string;
      matchCount: number;
      snippet: string;
      seq?: number;
      ts: string | null;
      message_count?: number;
      usage?: string | null;
      agent_active_ms?: number | null;
    }
    interface SearchPayload {
      recent: boolean;
      results: SearchHit[];
    }
  `;
  const copies = structuralCopies([...SOURCES, { rel: 'src/Renamed.tsx', text: copy }]);
  assert.deepEqual(copies.map((c) => c.split(' declares ')[1]).sort(), [
    'SearchHit, the field set of SearchResultItem (shared/rows.ts)',
    'SearchPayload, the field set of SearchResponse (shared/results.ts)',
  ]);
});
