// Removal pin for #331: the factory caller passes no `per_account_slots`.
//
// GitHub validates a reusable workflow's inputs when it PARSES the caller, so
// one input the factory no longer declares stops every job in this file
// whatever triggered it: dispatch, implement, review, implement-pr, merge-gate,
// audit, update-branch. The reconciler is one of them, so nothing would repair
// the stall either. That is why this is a pin and not a preference.
//
// `.github/workflows/factory.yml` is the only factory file this repo carries;
// everything it runs lives in chizhangucb/software-factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { read } from './helpers/tracked-files.mjs';

const CALLER = '.github/workflows/factory.yml';

const source = read(CALLER);
const lines = source.split('\n');

/** The `jobs:` block, as line numbers, for the pins that read prose. */
const jobLines = () => {
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(start, -1, 'the caller declares no `jobs:` block');
  return lines.slice(start).map((line, i) => ({ line, number: start + i + 1 }));
};

/** The `jobs:` block, parsed, the way GitHub reads it. */
const jobs = () => {
  const parsed = yaml.load(source);
  assert.ok(parsed?.jobs, 'the caller parses to no `jobs:` block');
  return parsed.jobs;
};

test('no job in the factory caller passes per_account_slots', () => {
  // By name, on the raw text, which the parsed pin below cannot do: the way
  // this input comes back is someone adding it to FACTORY_ROLES to quiet a
  // red test. Then the allowlist agrees with the caller and only this fails.
  const offenders = jobLines()
    .filter(({ line }) => /per_account_slots/.test(line))
    .map(({ line, number }) => `${CALLER}:${number}: ${line.trim()}`);
  assert.deepEqual(offenders, [], `the retired input is back:\n  ${offenders.join('\n  ')}`);
});

test('no job in the factory caller carries a comment about slots', () => {
  // Half the removal: a stale comment tells the next reader to set a number
  // the factory no longer declares, and that reader lands the parse failure.
  //
  // Comment lines inside `jobs:` only. The ONE other line in this file that
  // says "slots" is the schedule comment, and those are cron minute slots, a
  // different thing on a trigger this ticket does not touch.
  const offenders = jobLines()
    .filter(({ line }) => /^\s*#/.test(line) && /\bslots?\b/i.test(line))
    .map(({ line, number }) => `${CALLER}:${number}: ${line.trim()}`);
  assert.deepEqual(offenders, [], `a job still talks about slots:\n  ${offenders.join('\n  ')}`);
});

// --- The run still starts (#331, acceptance criterion 2) -------------------

// The factory roles this caller wires, one row each: the workflow its `uses:`
// must name, and the inputs it passes.
//
// A caller that loses a role loses the job: no dispatch is no sweep, no
// update-branch is no auto-merge. The roles are checked as a subset, so
// gaining one is an ordinary upstream change.
//
// `inputs` is per role, not global, because the factory declares them per
// workflow: `factory_ref` on all of them, `node_version` only where the
// target's own tooling runs, `trusted_author_associations` only on dispatch.
// One flat allowlist would pass a caller sending `node_version` to dispatch,
// which is the same parse failure this pin is for. Chronicle cannot read the
// factory's declarations from here, so these are the inputs each role passes
// today, on a caller the factory is running: widening a row is the step that
// says someone checked the factory declares the new name.
const FACTORY_ROLES = {
  dispatch: { workflow: 'dispatch.yml', inputs: ['factory_ref', 'trusted_author_associations'] },
  implement: { workflow: 'agent-implement.yml', inputs: ['factory_ref', 'node_version'] },
  review: { workflow: 'agent-review.yml', inputs: ['factory_ref', 'node_version'] },
  'implement-pr': { workflow: 'agent-implement-pr.yml', inputs: ['factory_ref', 'node_version'] },
  // test_command and install_command: both declared by merge-gate.yml, and both
  // needed to route a browser spec to the browser suite with Chromium installed (#335).
  'merge-gate': { workflow: 'merge-gate.yml', inputs: ['factory_ref', 'node_version', 'test_command', 'install_command'] },
  audit: { workflow: 'agent-audit.yml', inputs: ['factory_ref', 'node_version'] },
  'update-branch': { workflow: 'update-branch.yml', inputs: ['factory_ref'] },
};

test('every job passes only inputs the factory still declares', () => {
  const offenders = Object.entries(jobs()).flatMap(([id, job]) =>
    Object.keys(job.with ?? {})
      .filter((input) => !(FACTORY_ROLES[id]?.inputs ?? []).includes(input))
      .map((input) => `${id} -> ${input}`),
  );
  assert.deepEqual(
    offenders,
    [],
    'the caller passes an input the factory may not declare, which fails every job at parse ' +
      `time. Confirm the factory declares it, then add it to its FACTORY_ROLES row:\n  ${offenders.join('\n  ')}`,
  );
});

test('every factory role is still wired, at the ref its factory_ref names', () => {
  const declared = jobs();
  for (const [id, { workflow }] of Object.entries(FACTORY_ROLES)) {
    const job = declared[id];
    assert.ok(job, `the caller no longer declares the ${id} job`);
    const uses = job.uses ?? '';
    assert.ok(
      uses.startsWith(`chizhangucb/software-factory/.github/workflows/${workflow}@`),
      `${id} no longer calls ${workflow}, it calls: ${uses}`,
    );
    // factory_ref must equal the ref in `uses:`: the scripts are checked out at
    // factory_ref, and GitHub does not tell a reusable workflow which ref it
    // came from. The caller's own header says to change both together.
    assert.equal(job.with?.factory_ref, uses.split('@').pop(), `${id} pins two different factory refs`);
  }
});

test('a labelled ticket and a labelled PR each still reach a job', () => {
  const declared = jobs();
  // Each clause on its own, not in order: reordering an `if:` is an honest
  // refactor and must not read here as "no job runs on this label".
  const reaches = (id, event, label) => {
    const condition = declared[id]?.if ?? '';
    assert.ok(condition.includes(`github.event_name == '${event}'`), `${id} no longer runs on ${event}`);
    assert.ok(condition.includes(`'${label}'`), `${id} no longer runs on the ${label} label`);
  };
  reaches('implement', 'issues', 'agent:implement');
  reaches('review', 'pull_request_target', 'agent:review');
  reaches('implement-pr', 'pull_request_target', 'agent:implement');
});
