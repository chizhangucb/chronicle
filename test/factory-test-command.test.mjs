// CHI #335 regression guard: the factory's merge gate must run each kind of
// test with the command that kind needs.
//
// The gate runs the test files a factory PR touched, on main and on the branch,
// with one command our caller hands it. We have two kinds, so one command
// cannot serve both: handed to `node --test`, a browser spec dies on import
// before a single test reports. That is what happened on #320, where the gate
// posted a red check naming a healthy unit test alongside the spec.
//
// scripts/ci/factory-test-command.sh is the command that routes. Two things
// about it can quietly rot, so both are pinned here: the rule that says which
// files are browser specs, against playwright.config.ts, which is where that
// rule really lives; and the exit status, because a router that swallows a
// failing file hands us a green gate over a red test. Same shape as the other
// config guards (test/e2e-parallel-config.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = path.join(REPO, 'scripts/ci/factory-test-command.sh');
const router = fs.readFileSync(ROUTER, 'utf8');

// A stub for each command the router dispatches to: it records what it was
// asked to run, and fails for the files named in FAIL_ON.
const STUB = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$CALLS"
for doomed in $FAIL_ON; do
  case "$*" in *"$doomed"*) exit 1 ;; esac
done
exit 0
`;

/** Run the real router over these files, with the named ones failing. */
const route = (t, files, failOn = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls');
  for (const command of ['npm', 'node']) {
    fs.writeFileSync(path.join(dir, command), STUB, { mode: 0o755 });
  }
  // Invoked the way the merge gate invokes a target's test command, so a copy
  // that lost its executable bit fails here rather than in CI.
  const result = spawnSync('sh', ['-c', `${ROUTER} "$@"`, 'sh', ...files], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, FAIL_ON: failOn.join(' ') },
  });
  assert.equal(result.error, undefined, 'the router did not run at all');
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
};

test('the browser specs the router recognises are the ones Playwright would run', () => {
  // The router matches `test/e2e/*.spec.ts`. That is testDir + testMatch, and
  // this is what stops the two from drifting apart: a spec Playwright would run
  // and the router would not goes to `node --test` and dies on import.
  assert.equal(config.testDir, './test/e2e', 'testDir moved; the router still matches test/e2e/');
  assert.equal(config.testMatch, '**/*.spec.ts', 'testMatch changed; the router still matches *.spec.ts');
  assert.match(router, /test\/e2e\/\*\.spec\.ts\)/, 'the router no longer matches the directory and suffix above');
});

test('a browser spec goes to the browser suite and a unit test to node --test', (t) => {
  const run = route(t, ['test/e2e/ask.spec.ts', 'test/languages-removed.test.mjs']);
  assert.deepEqual(
    run.calls,
    ['npm run test:e2e -- test/e2e/ask.spec.ts', 'node --test test/languages-removed.test.mjs'],
    'each kind must reach the command that kind needs',
  );
  assert.equal(run.code, 0, 'every file passed, so the router passes');
});

test('a real browser spec from this repo routes to the browser suite', (t) => {
  // Read off the tree rather than written down, so a rename of the spec files
  // cannot leave this guard pinning a path that no longer exists.
  const specs = fs.readdirSync(path.join(REPO, 'test/e2e')).filter((f) => f.endsWith('.spec.ts'));
  assert.ok(specs.length > 0, 'no browser specs found to check the routing against');
  for (const spec of specs) {
    const run = route(t, [`test/e2e/${spec}`]);
    assert.match(run.calls[0], /^npm run test:e2e --/, `${spec} must go to the browser suite`);
  }
});

test('a file that failed fails the router, so the gate still sees a real result', (t) => {
  const run = route(t, ['test/languages-removed.test.mjs'], ['test/languages-removed.test.mjs']);
  assert.equal(run.calls.length, 1, 'the file must actually have been run');
  assert.notEqual(run.code, 0, 'a router that swallows a failure hands us a green gate over a red test');
});

test('a failing file never stops the ones after it, since the gate judges each on its own', (t) => {
  const files = ['test/a.test.mjs', 'test/e2e/b.spec.ts', 'test/c.test.mjs'];
  const run = route(t, files, ['test/a.test.mjs']);
  assert.deepEqual(run.calls.map((call) => call.replace(/^.* /, '')), files, 'every file must be attempted');
  for (const file of files) assert.match(run.output, new RegExp(`== ${file}`), `${file} must be named as it goes`);
  assert.notEqual(run.code, 0, 'one failure fails the whole invocation');
});
