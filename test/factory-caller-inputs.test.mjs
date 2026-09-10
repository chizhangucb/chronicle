// Removal pin for #331: the factory caller passes no `per_account_slots`.
//
// The factory's reusable workflows dropped the per-account cap and its slot
// job; every agent run is serialised against other runs on the same issue or
// PR and nothing else. A caller that passes an input the called workflow does
// not declare fails at PARSE time, which takes out every factory job on this
// repo at once -- dispatch, implement, review, implement-pr, gate, audit,
// update-branch -- including the reconciler that would otherwise repair the
// stall. So the pin is a pin, not a preference.
//
// `.github/workflows/factory.yml` is the only factory file this repo carries;
// everything it runs lives in chizhangucb/software-factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { read } from './helpers/tracked-files.mjs';

const CALLER = '.github/workflows/factory.yml';

test('no job in the factory caller passes per_account_slots', () => {
  const lines = read(CALLER).split('\n');
  const offenders = lines.flatMap((line, i) =>
    /per_account_slots/.test(line) ? [`${CALLER}:${i + 1}: ${line.trim()}`] : [],
  );
  assert.deepEqual(offenders, [], `the retired input is back:\n  ${offenders.join('\n  ')}`);
});

test('no job in the factory caller carries a comment about slots', () => {
  // The comment block above each input is half the removal: a stale comment
  // tells the next reader to set a number the factory no longer declares, and
  // that reader lands the parse failure this pin exists to prevent.
  //
  // Scoped to the `jobs:` block, because the ONE other line in this file that
  // says \"slots\" is the schedule comment, and those are cron minute slots --
  // a different thing, on a trigger the ticket does not touch.
  const lines = read(CALLER).split('\n');
  const jobs = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobs, -1, 'the caller declares no `jobs:` block');
  const offenders = lines
    .slice(jobs)
    .flatMap((line, i) =>
      /\bslots?\b/i.test(line) ? [`${CALLER}:${jobs + i + 1}: ${line.trim()}`] : [],
    );
  assert.deepEqual(offenders, [], `a job still talks about slots:\n  ${offenders.join('\n  ')}`);
});

// --- The run still starts (#331, acceptance criterion 2) -------------------
//
// The reason a stray input matters is not tidiness: GitHub validates a
// reusable workflow's inputs when it PARSES the caller, so one undeclared key
// stops every job in this file, whatever triggered it. These pins read the
// caller the way GitHub does -- parsed, per job -- and assert both halves of
// "the next labelled ticket or PR starts a factory run": nothing is passed
// that the factory does not declare, and the wiring that carries a label to a
// job is still there.

// Every input the factory's reusable workflows still declare. `factory_ref` is
// on all of them; `node_version` on the ones that run the target's tooling;
// `trusted_author_associations` on dispatch. `per_account_slots` was the
// fourth and is gone (software-factory#149) -- adding a name back here is a
// deliberate act, which is the point.
const DECLARED_INPUTS = new Set(['factory_ref', 'node_version', 'trusted_author_associations']);

// job id -> the substring of `uses:` that says which factory workflow it calls.
// A caller that loses a job loses the role: no dispatch is no sweep, no
// update-branch is no auto-merge, no reconciler is nothing to repair a stall.
const CALLED_WORKFLOWS = {
  dispatch: 'dispatch.yml',
  implement: 'agent-implement.yml',
  review: 'agent-review.yml',
  'implement-pr': 'agent-implement-pr.yml',
  gate: 'gate.yml',
  audit: 'agent-audit.yml',
  'update-branch': 'update-branch.yml',
};

const jobs = () => {
  const parsed = yaml.load(read(CALLER));
  assert.ok(parsed?.jobs, 'the caller parses to no `jobs:` block');
  return parsed.jobs;
};

test('every job passes only inputs the factory still declares', () => {
  const offenders = Object.entries(jobs()).flatMap(([id, job]) =>
    Object.keys(job.with ?? {})
      .filter((input) => !DECLARED_INPUTS.has(input))
      .map((input) => `${id} -> ${input}`),
  );
  assert.deepEqual(
    offenders,
    [],
    `the caller passes an input the factory does not declare, so every job fails at parse time:\n  ${offenders.join('\n  ')}`,
  );
});

test('every factory role is still wired, at the ref its factory_ref names', () => {
  const declared = jobs();
  assert.deepEqual(
    Object.keys(declared).sort(),
    Object.keys(CALLED_WORKFLOWS).sort(),
    'the caller gained or lost a factory role',
  );
  for (const [id, workflow] of Object.entries(CALLED_WORKFLOWS)) {
    const job = declared[id];
    const uses = job.uses ?? '';
    assert.match(
      uses,
      new RegExp(`^chizhangucb/software-factory/\\.github/workflows/${workflow.replace('.', '\\.')}@(.+)$`),
      `${id} no longer calls ${workflow}`,
    );
    // factory_ref must equal the ref in `uses:`: the scripts are checked out at
    // factory_ref, and GitHub does not tell a reusable workflow which ref it
    // came from. The header of the caller says to change both together.
    assert.equal(job.with?.factory_ref, uses.split('@').pop(), `${id} pins two different factory refs`);
  }
});

test('a labelled ticket and a labelled PR each still reach a job', () => {
  const declared = jobs();
  assert.match(
    declared.implement.if,
    /event_name == 'issues'.*'labeled'.*'agent:implement'/s,
    'no job runs when a ticket is labelled agent:implement',
  );
  assert.match(
    declared.review.if,
    /event_name == 'pull_request_target'.*'agent:review'/s,
    'no job runs when a PR is labelled agent:review',
  );
  assert.match(
    declared['implement-pr'].if,
    /event_name == 'pull_request_target'.*'agent:implement'/s,
    'no job runs when a PR is labelled agent:implement',
  );
});
