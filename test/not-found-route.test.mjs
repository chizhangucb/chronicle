// The not-found surface (issue #239).
//
// Chronicle mounted its pages as a flat list of independent matches with no
// fallback, so a path matching none of them rendered the chrome around an
// empty main area: nothing told the visitor the page was not there. The set of
// paths the app has a page for now lives in src/routes.ts, and the same table,
// asked through the router's own matcher, decides when NOTHING matches and the
// not-found surface takes over.
//
// `isRoutedPath` is the real decision, not a stand-in for it: App calls this
// exact function with the exact location the router hands it, so the tables
// below are the surface's behaviour, one path at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/read-source.mjs';
import { RETIRED_ROUTE_PREFIXES, RETIRED_WORDS } from './helpers/retired-vocabulary.mjs';
import { ROUTES, KNOWN_ROUTES, isRoutedPath } from '../src/routes.ts';

// Every route the app mounts, spelled as a path a visitor can land on. A page
// that stops being reachable fails here before it fails on the surface.
const REACHABLE = [
  '/',
  '/projects',
  '/project/12',
  '/project/12/explore',
  '/project/12/content',
  '/session/abc-123',
  '/insights',
  '/ask',
  '/reference',
];

// Paths nothing answers: a stale bookmark, a typo, a plausible-but-wrong
// plural, a real route with a segment too many or too few.
const UNROUTED = [
  '/jbos',
  '/sessions',
  '/insight',
  '/project',
  '/session',
  '/reference/spend',
  '/project/12/spend',
  '/nothing/here/at/all',
];

test('a routed path keeps its own page, so the fallback never covers one', () => {
  for (const path of REACHABLE) {
    assert.equal(isRoutedPath(path), true, `${path} should render its own page`);
  }
  // The shapes a URL arrives in that are still the same page: the router
  // ignores case and an optional trailing slash, and the fallback must too.
  for (const path of ['/projects/', '/project/12/explore/', '/PROJECTS']) {
    assert.equal(isRoutedPath(path), true, `${path} should render its own page`);
  }
});

test('an unrouted path is left to the fallback surface', () => {
  for (const path of UNROUTED) {
    assert.equal(isRoutedPath(path), false, `${path} should fall through to not-found`);
  }
});

// The fallback must not be a SECOND reading of the route patterns. wouter's
// own matcher answers a trailing slash, a cased path and a wildcard pattern in
// ways a hand-rolled matcher gets wrong one at a time, and each disagreement
// shows up as the fallback stacked under a page that did match.
test('the fallback asks the router\'s own matcher, not a copy of it', () => {
  const routes = readSource(path.join(REPO, 'src', 'routes.ts'));
  assert.match(routes, /import \{ matchRoute \} from 'wouter'/,
    'src/routes.ts no longer decides through the router\'s matcher');
  assert.match(routes, /matchRoute\(parse, pattern, path\)/, 'the matcher is not asked per pattern');
  assert.doesNotMatch(routes, /new RegExp\(/, 'src/routes.ts builds its own path matcher again');
});

// --- The surface, and the one place it is mounted -------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = readSource(path.join(REPO, 'src', 'App.tsx'));

test('App renders the not-found surface exactly when no route matches', () => {
  assert.match(app, /import NotFoundPage from '\.\/NotFoundPage\.tsx'/,
    'App does not mount the not-found surface');
  // The gate reads the CURRENT PATH, and nothing else: asked about any other
  // string in scope (the query string, a param) the fallback would answer for
  // paths that do have a page, and stack itself on top of them.
  const location = app.match(/const \[(\w+), navigate\] = useLocation\(\);/);
  assert.ok(location, 'App no longer reads the current path from the router');
  assert.ok(
    app.includes(`{!isRoutedPath(${location[1]}) && <NotFoundPage />}`),
    'the not-found surface must be gated on NOTHING matching the current path',
  );
});

test('every route the client matches comes from the shared table', () => {
  // A page mounted on a pattern the table does not carry would render with the
  // not-found surface stacked on top of it. ProjectDetail re-reads two of the
  // same routes to pick its tab, so it reads the table too.
  const patterns = [...app.matchAll(/useRoute\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.equal(patterns.length, KNOWN_ROUTES.length,
    `App matches ${patterns.length} routes, the table carries ${KNOWN_ROUTES.length}`);
  const detail = readSource(path.join(REPO, 'src', 'ProjectDetail.tsx'));
  const all = [...patterns, ...[...detail.matchAll(/useRoute\(([^)]*)\)/g)].map((m) => m[1].trim())];
  for (const arg of all) {
    assert.match(arg, /^ROUTES\.\w+$/, `useRoute(${arg}) does not read the shared route table`);
  }
});

test('every surviving page keeps its own match as its gate', () => {
  // The fallback is additive: it must not take over the rendering of a page
  // that already has a route, including the two that are gated on more than
  // the URL (Ask on its Settings toggle, the project pages on an id).
  for (const gate of [
    /\{atHome && \(/, /\{atProjects && \(/, /\{atReference && <ReferencePage \/>\}/,
    /\{atAsk && \(askEnabled/, /\{\(atProject \|\| atProjExplore \|\| atProjContent\) && projectId != null && \(/,
    /\{atSession && sessionId != null && \(/,
  ]) {
    assert.match(app, gate, `a page lost its own render gate: ${gate}`);
  }
});

// --- What the surface says ------------------------------------------------

const surface = readSource(path.join(REPO, 'src', 'NotFoundPage.tsx'));

/** The words a visitor actually reads: JSX text nodes, no markup, no comment. */
const copy = [...surface.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').matchAll(/>([^<>{}]+)</g)]
  .map((m) => m[1].trim())
  .filter(Boolean)
  .join(' ');

test('the surface says the page does not exist and offers the way back to Insights', () => {
  assert.match(copy, /does not exist/i, `the surface never says the page is not there: ${copy}`);
  assert.match(copy, /\bInsights\b/, 'the surface offers no way back to Insights');
  assert.match(surface, /<Link className="[^"]*" href=\{ROUTES\.home\}>/,
    'the way back must be a link to the Insights home route');
});

test('the surface renders in the existing page grammar', () => {
  // The same classes the welcome empty state uses, inside the app frame App
  // renders it in, not a new layout invented for one page.
  assert.match(surface, /className="page center empty-state/,
    'the surface invents its own layout instead of the shared empty-state grammar');
});

test('the surface neither names a removed surface nor guesses why the page is missing', () => {
  // A bookmark from an older release and a typo are indistinguishable from
  // here, so any explanation would be wrong for one of them. The Reference
  // page's retired group is the one place a dropped surface is explained.
  // Every word of every route the shrink removed, not the squashed prefix: a
  // multi-word route is named on a page by one of its words, never by the
  // run-together spelling squashing its separators out would produce. Short
  // connectors are dropped so the sweep flags a surface name, not an English
  // word.
  const removedSurfaces = RETIRED_ROUTE_PREFIXES
    .flatMap((prefix) => prefix.split(/[^a-z]+/i))
    .filter((word) => word.length >= 4);
  for (const name of removedSurfaces) {
    assert.doesNotMatch(copy, new RegExp(`\\b${name}\\b`, 'i'), `the copy names ${name}`);
  }
  for (const { word, re } of RETIRED_WORDS) {
    assert.doesNotMatch(copy, re, `the copy uses the retired word "${word}"`);
  }
  // Speculation about a cause, in any of the shapes it usually takes.
  assert.doesNotMatch(copy, /\b(removed|retired|moved|deleted|renamed|no longer|not connected|disconnected|used to)\b/i,
    `the copy guesses why the page is missing: ${copy}`);
});

// --- The contract carries it ----------------------------------------------

test('the surface contract carries the fallback as a route of its own', () => {
  // A surface exists once it is in the contract: spec/surface-contract.md is
  // the only place a surface is added, renamed or removed.
  const contract = readSource(path.join(REPO, 'spec', 'surface-contract.md'));
  assert.match(contract, /src\/NotFoundPage\.tsx/, 'the contract does not name the fallback component');
  assert.match(contract, /test\/not-found-route\.test\.mjs/, 'the contract does not name the pin guarding it');
});
