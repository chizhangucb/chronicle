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
