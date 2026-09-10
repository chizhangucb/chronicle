// CHI #335 regression guard: the factory's merge gate must run each kind of
// test with the command that kind needs.
//
// The gate runs the test files a factory PR touched, on main and on the branch,
// with one command our caller hands it. We have two kinds, so one command
// cannot serve both: handed to `node --test`, a browser spec dies on import
// before a single test reports. That is what happened on #320, where the gate
// posted a red check naming a healthy unit test alongside the spec.
//
// scripts/ci/factory-test-command.sh is the command that routes; its own header
// says why it routes the way it does. Two things about it can quietly rot, so
// both are pinned here by behaviour: where Playwright looks for specs, since
// playwright.config.ts is where that rule really lives, and the exit status,
// since a command that swallows a failing file hands us a green gate over a red
// test. Same shape as the other config guards (test/e2e-parallel-config.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTING_COMMAND = path.join(REPO, 'scripts/ci/factory-test-command.sh');

// A stub for each command it dispatches to: it records what it was asked to
// run, and fails for the files named in FAIL_ON.
const STUB = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$CALLS"
for doomed in $FAIL_ON; do
  case "$*" in *"$doomed"*) exit 1 ;; esac
done
exit 0
`;

/** Run the real routing test command over these files, with the named ones failing. */
const route = (t, files, failOn = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls');
  for (const command of ['npm', 'node']) {
    fs.writeFileSync(path.join(dir, command), STUB, { mode: 0o755 });
  }
  // The same form the gate invokes a target's test command in, so this runs the
  // real file the way CI will: a copy that lost its executable bit, or whose
  // shebang stopped resolving, reaches the assertions below as an empty call
  // list rather than passing quietly.
  const result = spawnSync('sh', ['-c', `${ROUTING_COMMAND} "$@"`, 'sh', ...files], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, FAIL_ON: failOn.join(' ') },
  });
  assert.equal(result.error, undefined, 'the routing test command could not be spawned');
  // 126/127 is the shell answering "cannot execute" / "not found". Without this
  // the promise above lands as a TypeError on `calls[0]` being undefined, which
  // names neither the file nor the reason.
  assert.ok(
    result.status !== 126 && result.status !== 127,
    `the routing test command would not execute (exit ${result.status}): ${result.stderr}`,
  );
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
};

test('a spec where Playwright looks for one reaches the browser suite', (t) => {
  // Built from the config rather than written down. Move testDir or testMatch
  // and the path built here moves with it, while a routing command still
  // matching the old place sends the spec to `node --test`, where it dies on
  // import. Nested too: testMatch is `**/`-prefixed and a case glob crosses `/`.
  //
  // Both fields have to be the string form for the path below to mean anything:
  // Playwright also takes a RegExp or an array, and either one would make the
  // derived path a TypeError rather than a readable "the rule moved".
  assert.equal(typeof config.testDir, 'string', 'testDir is no longer a plain path; derive the spec path from its new form');
  assert.equal(typeof config.testMatch, 'string', 'testMatch is no longer a plain glob; derive the spec name from its new form');
  const dir = config.testDir.replace(/^\.\//, '');
  const name = config.testMatch.replace('**/*', 'invented');
  assert.notEqual(name, config.testMatch, 'testMatch no longer starts `**/*`; the name derived below is not a spec name');
  for (const spec of [dir + '/' + name, dir + '/nested/' + name]) {
    const run = route(t, [spec]);
    assert.equal(run.calls[0], `npm run test:e2e -- ${spec}`, spec + ' is where Playwright looks; it must reach the browser suite, as itself');
  }
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

test('a file that failed fails the whole command, so the gate still sees a real result', (t) => {
  const run = route(t, ['test/languages-removed.test.mjs'], ['test/languages-removed.test.mjs']);
  assert.equal(run.calls.length, 1, 'the file must actually have been run');
  assert.notEqual(run.code, 0, 'swallowing a failure hands us a green gate over a red test');
});

test('a leading ./ still reaches the browser suite, since a hand run writes the path that way', (t) => {
  const run = route(t, ['./test/e2e/ask.spec.ts']);
  // The path too, not just the command: matching on the stripped path and
  // handing on the raw one leaves the two spellings free to drift apart.
  assert.equal(
    run.calls[0],
    'npm run test:e2e -- test/e2e/ask.spec.ts',
    'a ./-prefixed spec must not fall through to node --test, and reaches it as the path that was matched',
  );
});

test('given no files at all it fails rather than reporting a quiet success', (t) => {
  const run = route(t, []);
  assert.deepEqual(run.calls, [], 'nothing should have been run');
  assert.notEqual(run.code, 0, 'answering green having run nothing is the one thing the gate must never be told');
});

test('a failing file never stops the ones after it, since the gate judges each on its own', (t) => {
  const files = ['test/a.test.mjs', 'test/e2e/b.spec.ts', 'test/c.test.mjs'];
  const run = route(t, files, ['test/a.test.mjs']);
  assert.deepEqual(run.calls.map((call) => call.replace(/^.* /, '')), files, 'every file must be attempted');
  for (const file of files) assert.match(run.output, new RegExp(`== ${file}`), `${file} must be named as it goes`);
  assert.notEqual(run.code, 0, 'one failure fails the whole invocation');
});
