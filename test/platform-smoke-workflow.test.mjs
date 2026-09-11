// CHI #200 guard: the platform smoke has to run where it matters and nowhere
// it would hurt.
//
// Three things about this workflow rot silently. It can drift onto the repo
// checkout instead of the packed tarball, at which point it proves nothing
// about the published package. It can lose an OS from the matrix, at which
// point Windows goes back to never being run. And it can fall out of
// publish.yml, at which point a broken platform ships. Same shape as the
// other config guards (test/e2e-parallel-config.test.mjs): parse the real
// workflow files and assert the real values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/platform-smoke.yml';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const load = (rel) => yaml.load(read(rel));
// `on:` is YAML 1.1's boolean true once parsed, which is why GitHub's own
// docs quote it. Read it either way rather than depending on the spelling.
const triggers = (doc) => doc.on ?? doc[true];

const smoke = load(WORKFLOW);
const smokeText = read(WORKFLOW);
const publish = load('.github/workflows/publish.yml');
const steps = Object.values(smoke.jobs).flatMap((j) => j.steps ?? []);
const runs = steps.map((s) => s.run ?? '').join('\n');

test('the smoke runs on both operator platforms, and one failing OS fails the job', () => {
  const job = smoke.jobs.smoke;
  assert.ok(job, 'the workflow has no `smoke` job');
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(job.strategy['fail-fast'], false, 'fail-fast would hide the second OS behind the first');
  assert.equal(job['runs-on'], '${{ matrix.os }}');
  assert.equal(job['continue-on-error'], undefined, 'a failure on either OS must fail the job');
});

test('every step runs in the same shell on both OSes', () => {
  // windows-latest defaults to pwsh, ubuntu to bash: the same `run:` line then
  // means two different things. Git Bash ships on the Windows runner.
  assert.equal(smoke.defaults?.run?.shell ?? smoke.jobs.smoke.defaults?.run?.shell, 'bash');
});

test('it tests the packed tarball, not the repo checkout', () => {
  const packRuns = (smoke.jobs.pack.steps ?? []).map((s) => s.run ?? '').join('\n');
  assert.match(packRuns, /npm pack/, 'nothing packs the package');
  const handoff = (smoke.jobs.pack.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/upload-artifact'));
  assert.ok(handoff, 'the tarball is never handed to the smoke legs');
  const download = (smoke.jobs.smoke.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/download-artifact'));
  assert.ok(download, 'the smoke legs never download the tarball');
  assert.equal(download.with.name, handoff.with.name, 'the download names a different artifact than the upload');
  assert.ok((smoke.jobs.smoke.needs ?? []).includes('pack'), 'the smoke legs do not wait for the pack');

  const install = steps.map((s) => s.run ?? '').find((r) => /npm install/.test(r));
  assert.ok(install, 'nothing installs anything');
  assert.match(install, /\.tgz/, 'the install step does not install the packed tarball');
  assert.match(runs, /node_modules\/chronicle-cli/, 'the smoke is not pointed at the installed package');
});

test('it runs the smoke assertions and the screenshot run', () => {
  assert.match(runs, /scripts\/ci\/platform-smoke\.mjs --package-dir/);
  assert.match(runs, /scripts\/ci\/platform-screenshots\.mjs --package-dir/);
});

test('it runs on Node 24, the version the launcher preflight demands', () => {
  const setup = steps.filter((s) => (s.uses ?? '').startsWith('actions/setup-node'));
  assert.ok(setup.length, 'no setup-node step');
  for (const s of setup) assert.equal(String(s.with['node-version']), '24');
});

test('the screenshots are uploaded as an artifact from both OSes', () => {
  const upload = (smoke.jobs.smoke.steps ?? [])
    .find((s) => (s.uses ?? '').startsWith('actions/upload-artifact'));
  assert.ok(upload, 'no upload-artifact step in the matrix job');
  assert.match(upload.with.path, /screenshots/, 'the upload does not point at the screenshot dir');
  // upload-artifact@v4 SEALS an artifact when it closes: two matrix legs
  // uploading under one name is a 409 on whichever finishes second, not the
  // v3 merge. So the name has to carry the OS.
  assert.match(upload.with.name, /\$\{\{ matrix\.os \}\}/,
    `two OSes would upload under one name (${upload.with.name})`);
  // `if: always()`, because a red assertion is exactly when the pictures are wanted.
  assert.match(String(upload.if ?? ''), /always\(\)|!cancelled\(\)/);
  assert.notEqual(upload.with['if-no-files-found'], 'ignore', 'an empty artifact must not pass silently');
});

test('it runs on dispatch, on a PR that touches what it guards, and on call', () => {
  const on = triggers(smoke);
  assert.ok('workflow_dispatch' in on, 'not dispatchable');
  assert.ok('workflow_call' in on, 'publish.yml cannot call it without workflow_call');
  const paths = on.pull_request.paths;
  assert.ok(paths.some((p) => p.startsWith('bin/')), `bin/ is not a trigger path: ${paths}`);
  assert.ok(paths.includes('package.json'), `package.json is not a trigger path: ${paths}`);
  assert.ok(paths.includes(WORKFLOW), 'the workflow does not trigger on itself');
  assert.ok(paths.some((p) => p.startsWith('scripts/ci/platform')), 'its own scripts do not trigger it');
});

test('it gates the npm publish', () => {
  const caller = Object.entries(publish.jobs).find(([, j]) => (j.uses ?? '').includes('platform-smoke.yml'));
  assert.ok(caller, 'publish.yml never calls the platform smoke');
  const [callerId] = caller;
  assert.ok(
    (publish.jobs.publish.needs ?? []).includes(callerId),
    `the publish job does not need ${callerId}, so a broken platform would still ship`,
  );
});

test('it is not a required merge check', () => {
  // Branch protection requires jobs by check name. A Windows runner is slow
  // and this guards the release, not every PR, so it must not publish a check
  // that collides with one of the required ones, and the merge gate must not
  // call it.
  const required = ['check', 'e2e', 'gitleaks'];
  const names = Object.entries(smoke.jobs).map(([id, j]) => j.name ?? id);
  for (const n of names) assert.ok(!required.includes(n), `${n} collides with a required check`);
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /platform-smoke/, 'the merge gate calls the platform smoke');
});

test('contributing.md says what the platform smoke covers and when it runs', () => {
  // One short passage, not a section: the doc is wrapped at ~98 columns, so
  // the unit is the paragraph.
  const passage = read('docs/contributing.md')
    .split(/\n\s*\n/)
    .find((p) => /platform smoke/i.test(p));
  assert.ok(passage, 'docs/contributing.md never mentions the platform smoke');
  assert.ok(passage.split('\n').length <= 6, 'one line, not an essay');
  assert.match(passage, /Windows/, 'it does not say which platforms it covers');
  assert.match(passage, /npm pack|tarball/, 'it does not say it tests the packed package');
  assert.match(passage, /publish|release/i, 'it does not say when it runs');
  assert.match(passage, /not a required|Not a required/, 'it does not say it is not a merge gate');
});
