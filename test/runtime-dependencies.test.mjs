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
