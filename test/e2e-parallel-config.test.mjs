// CHI #245 regression guard: the e2e gate must stay parallel, sharded, and
// honest about flakes.
//
// The suite went from 1 worker / 1 runner to 2 workers across 3 CI shards.
// Every one of those settings is a single line someone can quietly revert
// while debugging a flake — and reverting them looks like a fix, because a
// serial suite hides races instead of failing on them. Same shape as the
// other config/workflow guards (test/repo-shape.test.mjs): read the real
// files, assert the real values, run in the `check` job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

// One job's block, from its `  <id>:` line to the next job at the same indent.
// Job-scoped rather than whole-file matching, so a pin cannot pass because the
// string it wanted happened to live in some other job.
const jobBody = (id) => {
  const start = new RegExp(`^ {2}${id}:$`, 'm').exec(ci);
  if (!start) return '';
  const rest = ci.slice(start.index + start[0].length);
  const next = /^ {2}[a-z][\w-]*:$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};

test('the e2e suite runs on more than one worker', () => {
  assert.equal(typeof config.workers, 'number', 'workers must be a fixed number, not left to Playwright');
  assert.ok(config.workers > 1, `expected more than one worker, got ${config.workers}`);
});

test('parallelism is full: tests split within a file, not just across files', () => {
  assert.equal(config.fullyParallel, true);
});

test('a spec that passes only on retry fails the job', () => {
  assert.equal(config.retries, 1, 'one retry absorbs a genuine blip; more hides races');
  assert.equal(config.failOnFlakyTests, true, 'without this the retry silently launders a race into a pass');
});

test('the CI e2e job is sharded across at least 3 runners', () => {
  const matrix = /shard: \[([^\]]+)\]/.exec(ci);
  assert.ok(matrix, 'ci.yml declares no e2e shard matrix');
  const shards = matrix[1].split(',').map((s) => Number(s.trim()));
  assert.ok(shards.length >= 3, `expected at least 3 shards, got ${shards.length}`);
  assert.deepEqual(shards, shards.map((_unused, i) => i + 1), 'shards must be 1..N, the form --shard=i/N expects');
  assert.match(
    ci,
    new RegExp(`--shard=\\$\\{\\{ matrix\\.shard \\}\\}/${shards.length}`),
    `every shard must be run as i/${shards.length}`,
  );
});

test('the shards still roll up under the required check named `e2e`', () => {
  // Branch protection requires `e2e` by name. A matrix job publishes one
  // check per shard, so the matrix lives under a different id and `e2e` is
  // the roll-up that fails when any shard did not succeed.
  const jobIds = [...ci.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
  assert.ok(jobIds.includes('e2e'), 'ci.yml declares no `e2e` job for branch protection to require');
  assert.ok(jobIds.includes('e2e-shard'), 'ci.yml declares no `e2e-shard` matrix job');
  assert.match(jobBody('e2e'), /needs:.*\be2e-shard\b/, '`e2e` does not depend on the shards');
  assert.match(ci, /needs\.e2e-shard\.result/, '`e2e` never checks the shards\' result, so it cannot go red');
});

// ---------------------------------------------------------------------------
// CHI #246: the gate is also skipped where it cannot apply.
//
// A PR that touches only docs, the website or root markdown cannot break the
// e2e suite, so it does not pay the several minutes to run it. The
// classification lives in `scripts/ci/e2e-applies.sh` rather than inline in
// the workflow, so it can be driven directly here instead of pattern-matched
// out of YAML.

const applies = (paths) =>
  execFileSync('bash', [path.join(REPO, 'scripts/ci/e2e-applies.sh')], {
    input: paths.join('\n'),
    encoding: 'utf8',
  }).trim();

test('a change that only touches docs, the website or root markdown skips e2e', () => {
  for (const paths of [
    ['docs/guide/import.md'],
    ['docs/agents/issue-tracker.md'],
    ['website/index.html', 'website/package.json'],
    ['README.md'],
    ['CLAUDE.md', 'CONTEXT.md'],
    ['docs/contributing/release.md', 'website/src/app.tsx', 'AGENTS.md'],
    [],
  ]) {
    assert.equal(applies(paths), 'false', `expected e2e to be skipped for ${JSON.stringify(paths)}`);
  }
});

test('a change that touches anything else still runs e2e', () => {
  for (const paths of [
    ['server/laneC.ts'],
    ['src/App.tsx'],
    ['test/e2e/smoke.spec.ts'],
    ['package.json'],
    ['playwright.config.ts'],
    ['.github/workflows/ci.yml'],
    ['spec/surface-contract.md'],
    ['docs/guide/import.md', 'server/laneC.ts'],
    ['website/index.html', 'src/App.tsx'],
  ]) {
    assert.equal(applies(paths), 'true', `expected e2e to run for ${JSON.stringify(paths)}`);
  }
});

test('the workflow gates the real e2e jobs on that classification', () => {
  const changes = jobBody('changes');
  assert.ok(changes, 'ci.yml declares no `changes` job to classify the diff');
  // Against the job body, not the whole file: the comment above `changes:`
  // names the script too, so a whole-file match would stay green after the
  // step that actually runs it was deleted.
  assert.match(changes, /bash scripts\/ci\/e2e-applies\.sh/, 'the `changes` job does not run the shared classifier');
  assert.match(
    changes,
    /git diff --name-only --no-renames "\$\{PR_BASE_SHA\}\.\.\.\$\{PR_HEAD_SHA\}"/,
    'the diff must be three-dot (the PR\'s own changes) and --no-renames (a move reports both sides)',
  );
  for (const job of ['e2e-shard', 'e2e']) {
    const body = jobBody(job);
    assert.match(body, /needs:.*\bchanges\b/, `\`${job}\` does not depend on \`changes\``);
  }
});

test('a broken classifier pays for the gate rather than skipping it', () => {
  // The hole this closes: if the `changes` job fails, its output is the empty
  // string. Gating on `== 'true'` would skip both the shards and the roll-up,
  // and a skipped required check reads as passing — so a red PR could merge on
  // the strength of a broken classifier. Only an explicit `false` buys a skip.
  for (const job of ['e2e-shard', 'e2e']) {
    const body = jobBody(job);
    assert.match(
      body,
      /needs\.changes\.outputs\.e2e != 'false'/,
      `\`${job}\` must skip only on an explicit 'false', so a failed classifier still runs the gate`,
    );
    assert.doesNotMatch(
      body,
      /needs\.changes\.outputs\.e2e == 'true'/,
      `\`${job}\` gates on == 'true', which a failed classifier silently satisfies as a skip`,
    );
    assert.match(body, /!cancelled\(\)/, `\`${job}\` leaves the implicit success() on, which skips it when \`changes\` fails`);
  }
});

test('a skipped run still reports a green `e2e` check via the stub', () => {
  // Branch protection requires the name `e2e`. When the real roll-up is
  // filtered out, a stub job publishing under the same check name is what
  // keeps that required check satisfiable — so a docs-only PR is not left
  // waiting on a job that will never run.
  const stub = jobBody('e2e-stub');
  assert.ok(stub, 'ci.yml declares no `e2e-stub` job beside the real `e2e` roll-up');
  assert.match(stub, /^ {4}name: e2e$/m, 'the stub does not publish under the required check name `e2e`');
  assert.match(
    stub,
    /needs\.changes\.outputs\.e2e == 'false'/,
    'the stub must run only on an explicit `false`, the strict complement of the real job',
  );
});
