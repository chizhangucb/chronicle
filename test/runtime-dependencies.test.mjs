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
