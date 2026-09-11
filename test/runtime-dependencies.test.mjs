// The published package's runtime dependency surface (issue #361).
//
// `npx chronicle-cli` downloads whatever the manifest declares under
// `dependencies`, so a library only the test suite imports is bandwidth every
// user pays for and an advisory surface every user carries. Express is the one
// thing the server actually needs at runtime; everything else -- the client
// toolchain, the type packages, js-yaml in test/factory-caller-inputs.test.mjs
// -- is a build-time or test-time tool and belongs in `devDependencies`.
//
// Reads package.json and package-lock.json from the checkout: the lockfile is
// what `npm ci` and `npm ls --omit=dev` resolve against, so pinning it needs no
// install and cannot go stale against node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/tracked-files.mjs';

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('Express is the only runtime dependency the manifest declares', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['express']);
});

test('js-yaml is declared as a dev dependency, next to its own types', () => {
  assert.equal(
    'js-yaml' in (pkg.dependencies ?? {}),
    false,
    'js-yaml is still a runtime dependency',
  );
  assert.ok(pkg.devDependencies?.['js-yaml'], 'js-yaml is declared nowhere');
  assert.ok(
    pkg.devDependencies?.['@types/js-yaml'],
    '@types/js-yaml moved away from the package it types',
  );
});

// `1.10.0` is newer than `1.9.0`, so a floor check compares release numbers,
// never strings. Prerelease tags never reach the lockfile here, so the numeric
// triple is the whole comparison.
const atLeast = (version, floor) => {
  const [a, b] = [version, floor].map((v) => v.split('.').map(Number));
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
};

// Every entry the lockfile resolves for one package name, including the nested
// copies npm installs when two dependents disagree about a range.
const resolved = (name) =>
  Object.entries(lock.packages)
    .filter(([where]) => where.endsWith(`node_modules/${name}`))
    .map(([where, entry]) => ({ where, version: entry.version }));

// Dependabot alerts 34 and 35 (qs, medium x2) and 36 (js-yaml, high). qs
// arrives through express and body-parser, so it ships to every user and a
// single un-bumped nested copy would keep both alerts open.
const PATCHED = [
  { name: 'qs', floor: '6.16.0' },
  { name: 'js-yaml', floor: '4.3.2' },
];

for (const { name, floor } of PATCHED) {
  test(`the lockfile resolves ${name} to >= ${floor} everywhere it appears`, () => {
    const copies = resolved(name);
    assert.ok(copies.length > 0, `the lockfile resolves no ${name} at all`);
    const behind = copies.filter(({ version }) => !atLeast(version, floor));
    assert.deepEqual(
      behind,
      [],
      `${name} is below ${floor}: ${behind.map((c) => `${c.where}@${c.version}`).join(', ')}`,
    );
  });
}

// What `npm ci --omit=dev` installs: npm marks an entry `dev: true` when every
// path to it runs through devDependencies, so the unmarked entries are the
// production tree. The root entry ("") is the package itself, not a download.
const productionTree = () =>
  new Set(
    Object.entries(lock.packages)
      .filter(([where, entry]) => where !== '' && !entry.dev)
      .map(([where]) => where),
  );

// Node's resolution, walked the way `npm ls` walks it: a dependency is the
// nested copy if one was installed, else the nearest copy up the tree.
const locate = (from, name) => {
  const segments = from === '' ? [] : from.split('/');
  for (let depth = segments.length; depth >= 0; depth -= 2) {
    const where = [...segments.slice(0, depth), 'node_modules', name].join('/');
    if (lock.packages[where]) return where;
  }
  return null;
};

// Everything reachable from Express: the tree a user gets for the one runtime
// dependency. Optional deps count -- npm installs the ones that apply to the
// platform, so they ship too.
const expressTree = () => {
  const seen = new Set();
  const queue = [locate('', 'express')];
  while (queue.length > 0) {
    const where = queue.pop();
    if (where === null || seen.has(where)) continue;
    seen.add(where);
    const entry = lock.packages[where];
    const names = Object.keys({ ...entry.dependencies, ...entry.optionalDependencies });
    queue.push(...names.map((name) => locate(where, name)));
  }
  return seen;
};

test('an install without dev dependencies downloads Express and its own tree, nothing else', () => {
  const production = productionTree();
  const express = expressTree();
  const strays = [...production].filter((where) => !express.has(where));
  assert.deepEqual(strays, [], `a package outside Express's tree ships to users: ${strays}`);
  assert.deepEqual(
    [...express].filter((where) => !production.has(where)),
    [],
    "Express's tree reaches a package the lockfile marks dev-only",
  );
});

test('no js-yaml reaches a user who installs without dev dependencies', () => {
  const shipped = [...productionTree()].filter((where) => where.endsWith('node_modules/js-yaml'));
  assert.deepEqual(shipped, [], `js-yaml still ships to users: ${shipped}`);
});

// NOTICE section 2 is the legal statement of what the published package
// bundles, and no sweep reaches it: test/repo-shape.test.mjs sweeps AGENTS.md,
// README.md, docs/*.md and spec/*.md only, so section 2 kept naming js-yaml,
// three and react-force-graph-3d long after the Memory graph was retired and
// the last two stopped being dependencies at all. This pin ties it to the
// manifest so it can only drift again by way of a failing test.
const NOTICE_RUNTIME = read('NOTICE')
  .split(/^\s*\d+\.\s+/m)
  .find((section) => section.startsWith('Bundled runtime dependencies'));

const noticed = (NOTICE_RUNTIME ?? '')
  .split('\n')
  .map((line) => line.match(/^\s+-\s+(\S+)/)?.[1])
  .filter(Boolean);

test('NOTICE names a bundled-runtime-dependencies section', () => {
  assert.ok(NOTICE_RUNTIME, 'NOTICE has no numbered "Bundled runtime dependencies" section');
});

test('NOTICE lists exactly the runtime dependencies the package declares', () => {
  const declared = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    noticed.map((name) => name.toLowerCase()),
    declared,
    `NOTICE section 2 lists ${noticed} but the package depends on ${declared}`,
  );
});

test('NOTICE keeps no trace of the retired Memory graph', () => {
  assert.doesNotMatch(
    NOTICE_RUNTIME ?? '',
    /\bthree\b|react-force-graph|memory graph|3D canvas/i,
    'NOTICE section 2 still describes the retired Memory graph',
  );
});
