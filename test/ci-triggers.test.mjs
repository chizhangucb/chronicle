// #365 guard: what starts the CI gate, and what the gate is when it starts.
//
// The gate used to run on a push to `main` as well. It does not any more: a
// pull request may only merge when its branch is up to date (branch
// protection's `required_status_checks.strict`), so what lands on `main` is
// exactly what the pull request just checked, and the re-run repeats it. The
// manual trigger is how `main` gets checked after a merge that bypassed the
// gate, so it has to run the SAME jobs a pull request does. A manual run that
// quietly skipped e2e would be a green that means nothing.
//
// Both halves are one line each in the workflow, and both come back by
// accident: `push:` is the reflex when someone wants "check main", and a
// manual run drifts into a cheaper gate the first time someone filters a job
// on `github.event_name == 'pull_request'`. The pins read the real workflow
// and evaluate the real conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './helpers/tracked-files.mjs';
import { workflow } from './helpers/workflow-conditions.mjs';

const WORKFLOW = '.github/workflows/ci.yml';
const ci = workflow(WORKFLOW);
const triggers = ci.triggers;

/** The job ids a run of this workflow starts, for an event and a classifier verdict. */
const jobsFor = (event, e2e) =>
  event in triggers
    ? ci.jobsFor({ github: { event_name: event }, needs: { changes: { outputs: { e2e } } } })
    : [];

test('the gate runs on a pull request and on a manual trigger, and on nothing else', () => {
  assert.deepEqual(
    Object.keys(triggers).sort(),
    ['pull_request', 'workflow_dispatch'],
    `${WORKFLOW} must run on a pull request and a manual trigger only. A push to \`main\` re-runs ` +
      'what the pull request already checked, because branch protection requires the branch to be up to date',
  );
  assert.deepEqual(triggers.pull_request.branches, ['main'], 'the gate must judge pull requests targeting `main`');
});

test('a manual run does exactly the checks a code pull request does, and a push starts nothing', () => {
  // The classifier says `true` on a manual run (no PR to diff), so that is the
  // verdict both runs are compared under: a code PR gets the full gate too.
  const full = ['gitleaks', 'check', 'changes', 'e2e-shard', 'e2e'];
  assert.deepEqual(jobsFor('pull_request', 'true'), full, 'a code pull request no longer runs the full gate');
  assert.deepEqual(
    jobsFor('workflow_dispatch', 'true'),
    full,
    'a manual run must do the same checks a pull request does: it is how `main` gets checked after a ' +
      'merge that bypassed the gate',
  );
  assert.deepEqual(jobsFor('push', 'true'), [], 'a push to `main` must start no job');
});

test('a docs-only pull request swaps the e2e roll-up for its stub, on either trigger', () => {
  // The complement, so the pin above cannot pass on a workflow that lost the
  // classifier entirely and runs everything unconditionally.
  const skipped = ['gitleaks', 'check', 'changes', 'e2e-stub'];
  assert.deepEqual(jobsFor('pull_request', 'false'), skipped);
  assert.deepEqual(jobsFor('workflow_dispatch', 'false'), skipped);
});

test('a manual run classifies as the full gate, because there is no pull request to narrow it to', () => {
  // The `changes` job's own script, run as the workflow runs it, with no PR in
  // the environment. This is what makes the manual trigger a real check of
  // `main` rather than a skip: the classifier only narrows a pull request.
  const classify = ci.doc.jobs.changes.steps.find((step) => step.id === 'classify');
  assert.ok(classify?.run, `${WORKFLOW}'s \`changes\` job has no \`classify\` step to run`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-ci-'));
  const output = path.join(dir, 'github-output');
  fs.writeFileSync(output, '');
  try {
    execFileSync('bash', ['-c', classify.run], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PR_BASE_SHA: '', PR_HEAD_SHA: '', GITHUB_OUTPUT: output },
    });
    const written = fs.readFileSync(output, 'utf8');
    assert.match(written, /^e2e=true$/m, 'a run with no pull request must pay for the full gate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
