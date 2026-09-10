// The not-found surface (issue #239).
//
// Chronicle mounted its pages as a flat list of independent matches with no
// fallback, so a path matching none of them rendered the chrome around an
// empty main area: nothing told the visitor the page was not there. The set of
// paths the app has a page for now lives in src/routes.ts, and the same list
// decides when NOTHING matches and the not-found surface takes over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/read-source.mjs';
import { ROUTES, KNOWN_ROUTES, isKnownPath } from '../src/routes.ts';

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

test('every path the app mounts a page for is a known path', () => {
  for (const path of REACHABLE) {
    assert.equal(isKnownPath(path), true, `${path} should render its own page`);
  }
});

test('an unrouted path is not a known path, so the fallback surface takes it', () => {
  for (const path of UNROUTED) {
    assert.equal(isKnownPath(path), false, `${path} should fall through to not-found`);
  }
});

test('the route table covers every pattern, so the fallback cannot miss one', () => {
  // KNOWN_ROUTES is what the fallback reads; ROUTES is what App.tsx matches on.
  // One list or the two drift and a mounted page starts reading "not found".
  assert.deepEqual([...KNOWN_ROUTES].sort(), Object.values(ROUTES).sort());
  assert.ok(KNOWN_ROUTES.includes('/'), 'the home path is missing from the route table');
});

// The fallback and the mounted pages must answer the same way for the same
// URL, or a page renders under a path the fallback also claims (both surfaces
// at once) or claims none (empty chrome again). The router's own matcher is
// the arbiter here, so this stays true if wouter changes how it parses a
// pattern.
test('the fallback matches a path exactly as the router does', async () => {
  const { matchRoute } = await import('wouter');
  // regexparam IS the router's parser (wouter imports it as `parsePattern` and
  // hands it to matchRoute), so this compares against the real thing rather
  // than against a second guess at it.
  const { parse } = await import('regexparam');
  const paths = [
    ...REACHABLE, ...UNROUTED,
    '/projects/', '/project/12/', '/', '//projects', '/PROJECTS', '/project/12/explore/',
  ];
  for (const path of paths) {
    const routed = KNOWN_ROUTES.some((pattern) => matchRoute(parse, pattern, path)[0]);
    assert.equal(isKnownPath(path), routed, `${path}: the fallback and the router disagree`);
  }
});

// --- The surface, and the one place it is mounted -------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = readSource(path.join(REPO, 'src', 'App.tsx'));

test('App renders the not-found surface exactly when no route matches', () => {
  assert.match(app, /import NotFoundPage from '\.\/NotFoundPage\.tsx'/,
    'App does not mount the not-found surface');
  assert.match(app, /\{!isKnownPath\([A-Za-z]+\) && <NotFoundPage \/>\}/,
    'the not-found surface must be gated on NOTHING matching, not on a route of its own');
});

test('every route App matches comes from the shared table', () => {
  // A page mounted on a pattern the table does not carry would render with the
  // not-found surface stacked on top of it.
  const patterns = [...app.matchAll(/useRoute\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.equal(patterns.length, KNOWN_ROUTES.length,
    `App matches ${patterns.length} routes, the table carries ${KNOWN_ROUTES.length}`);
  for (const arg of patterns) {
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
