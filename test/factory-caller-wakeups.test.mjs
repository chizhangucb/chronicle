// #365 guard: what wakes the factory on this repo, and what the pause stops.
//
// `.github/workflows/factory.yml` is a copy of software-factory's caller
// template, and a copy drifts. Three of its rules are the ones that hurt when
// they rot, so they are pinned here as behaviour (the event goes in, the jobs
// that would start come out) rather than as text:
//
//   The factory's own label removals wake nothing. A run's cleanup takes its
//   own `agent:*` state label off the ticket; when that removal woke a sweep,
//   the sweep could re-stamp the ticket it had just finished with.
//
//   A label edit or an assignee removal on a CLOSED ticket wakes nothing. The
//   ticket is done; touching its labels is bookkeeping, not a request to work.
//
//   The repository variable `FACTORY_PAUSED` stops this target. Set it to any
//   non-empty value and no work starts or advances, so an operator can stop the
//   factory here without disabling the workflow. Pull requests are still judged:
//   the merge gate is a required check, and pausing it would strand every open PR.
//
// Conditions are evaluated, not matched, so reordering an `if:` reads as the
// honest refactor it is and deleting a clause reads as the regression it is.
// test/factory-caller-inputs.test.mjs pins the other half of this file: the
// inputs each job passes, which GitHub validates when it parses the caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './helpers/workflow-conditions.mjs';

const CALLER = '.github/workflows/factory.yml';
const caller = workflow(CALLER);
const triggers = caller.triggers;

/** The repository variable that stops this target, and the caller's name for it. */
const PAUSE = 'FACTORY_PAUSED';

/** The job ids this event would start. `paused` is the variable's value, unset by default. */
const jobsFor = (event, { paused = '' } = {}) => caller.jobsFor({ github: event, vars: { [PAUSE]: paused } });

/** An `issues` event: the action, the label it carries, and whether the ticket is open. */
const ticket = (action, { label, state = 'open' } = {}) => ({
  event_name: 'issues',
  event: { action, issue: { state }, ...(label ? { label: { name: label } } : {}) },
});

const labelledPr = (label) => ({
  event_name: 'pull_request_target',
  event: { action: 'labeled', label: { name: label } },
});
const openPr = { event_name: 'pull_request', event: { action: 'synchronize', pull_request: { merged: false } } };
const mergedPr = {
  event_name: 'pull_request',
  event: { action: 'closed', pull_request: { merged: true } },
};
const heartbeat = { event_name: 'repository_dispatch', event: { action: 'factory-sweep' } };
const updateBranch = { event_name: 'repository_dispatch', event: { action: 'factory-update-branch' } };

// --- The factory's own label removals --------------------------------------

test('a factory state label coming off a ticket wakes nothing', () => {
  // These are the labels the factory writes and its own cleanup removes. A
  // sweep woken by one of them re-scans every ticket, including the one the
  // run just finished, which is how a finished ticket gets re-stamped.
  for (const label of ['agent:implement', 'agent:in-progress', 'agent:review', 'agent:blocked', 'factory:retry-1']) {
    assert.deepEqual(
      jobsFor(ticket('unlabeled', { label })),
      [],
      `removing \`${label}\` still wakes the factory, so a run's own cleanup can re-stamp its ticket`,
    );
  }
});

test("a human's blocker coming off an open ticket still wakes the sweep", () => {
  // The reason the caller listens to `unlabeled` at all: the ticket reaches
  // the factory the moment the human clears the blocker, instead of waiting
  // up to ten minutes for the next heartbeat.
  for (const label of ['hold', 'ready-for-human', 'needs-human', 'needs-info']) {
    assert.deepEqual(jobsFor(ticket('unlabeled', { label })), ['dispatch'], `removing \`${label}\` wakes no sweep`);
  }
});

test('an assignee coming off an open ticket still wakes the sweep', () => {
  assert.deepEqual(jobsFor(ticket('unassigned')), ['dispatch']);
});

test('`ready-for-agent` landing on an open ticket still wakes the sweep', () => {
  assert.deepEqual(jobsFor(ticket('labeled', { label: 'ready-for-agent' })), ['dispatch']);
});

test('`agent:implement` landing on an open ticket still starts the implementer', () => {
  assert.deepEqual(jobsFor(ticket('labeled', { label: 'agent:implement' })), ['implement']);
});

// --- The closed ticket -----------------------------------------------------

test('a label edit or an assignee removal on a closed ticket starts no job', () => {
  for (const event of [
    ticket('labeled', { label: 'ready-for-agent', state: 'closed' }),
    ticket('labeled', { label: 'agent:implement', state: 'closed' }),
    ticket('unlabeled', { label: 'hold', state: 'closed' }),
    ticket('unlabeled', { label: 'ready-for-human', state: 'closed' }),
    ticket('unassigned', { state: 'closed' }),
  ]) {
    assert.deepEqual(
      jobsFor(event),
      [],
      `a ${event.event.action} on a closed ticket still starts a job: ${JSON.stringify(event.event)}`,
    );
  }
});

test('closing a ticket still wakes the sweep, which is how a run is reconciled', () => {
  // The `closed` action arrives with the ticket already closed, so the rule
  // above must not swallow it.
  const closedTicket = { event_name: 'issues', event: { action: 'closed', issue: { state: 'closed' } } };
  assert.deepEqual(jobsFor(closedTicket), ['dispatch']);
});

// --- The pause -------------------------------------------------------------

test('the caller reads a repository variable, so the pause needs no code change', () => {
  const conditions = Object.values(caller.doc.jobs).map((job) => job.if ?? '');
  assert.ok(
    conditions.some((condition) => condition.includes(`vars.${PAUSE}`)),
    `no job in ${CALLER} reads \`vars.${PAUSE}\`, so this target can only be stopped by disabling the workflow`,
  );
});

test('with the pause set, no work starts or advances', () => {
  const events = [
    heartbeat,
    { event_name: 'schedule', event: {} },
    { event_name: 'workflow_dispatch', event: {} },
    ticket('labeled', { label: 'ready-for-agent' }),
    ticket('labeled', { label: 'agent:implement' }),
    ticket('unlabeled', { label: 'hold' }),
    ticket('unassigned'),
    ticket('closed'),
    labelledPr('agent:review'),
    labelledPr('agent:implement'),
    mergedPr,
    { event_name: 'push', event: {} },
    updateBranch,
  ];
  for (const event of events) {
    assert.deepEqual(
      jobsFor(event, { paused: '1' }),
      [],
      `paused, ${event.event_name}/${event.event.action ?? ''} still starts a job`,
    );
  }
  // Any non-empty value pauses, so a `true`, a `yes` or a date all stop the
  // factory rather than one magic spelling. An empty value reads as unset,
  // which is GitHub's own rule for a variable that is not there.
  for (const value of ['true', 'yes', 'chi is away until the 14th']) {
    assert.deepEqual(jobsFor(heartbeat, { paused: value }), [], `\`${PAUSE}=${value}\` did not pause the factory`);
  }
});

test('a paused factory still judges pull requests', () => {
  // The merge gate is a required check. Pausing it would strand every open
  // pull request behind a check that never reports, which is not a pause.
  assert.deepEqual(jobsFor(openPr, { paused: '1' }), ['merge-gate']);
});

test('with the pause unset, every trigger still reaches its job', () => {
  assert.deepEqual(jobsFor(heartbeat), ['dispatch']);
  assert.deepEqual(jobsFor({ event_name: 'schedule', event: {} }), ['dispatch']);
  assert.deepEqual(jobsFor({ event_name: 'workflow_dispatch', event: {} }), ['dispatch']);
  assert.deepEqual(jobsFor(labelledPr('agent:review')), ['review']);
  assert.deepEqual(jobsFor(labelledPr('agent:implement')), ['implement-pr']);
  assert.deepEqual(jobsFor(openPr), ['merge-gate']);
  assert.deepEqual(jobsFor(mergedPr), ['audit']);
  assert.deepEqual(jobsFor({ event_name: 'push', event: {} }), ['update-branch']);
  assert.deepEqual(jobsFor(updateBranch), ['update-branch']);
});

// --- The triggers the rules above are written against ----------------------

test('the caller still subscribes to every trigger its jobs read', () => {
  // A rule is only as good as the event that carries it: dropping `unlabeled`
  // from `on:` would pass every pin above and still leave a human's blocker
  // removal waiting on the next heartbeat.
  assert.deepEqual(triggers.issues.types.slice().sort(), ['closed', 'labeled', 'unassigned', 'unlabeled']);
  assert.deepEqual(triggers.pull_request_target.types, ['labeled']);
  assert.deepEqual(triggers.pull_request.types.slice().sort(), ['closed', 'opened', 'reopened', 'synchronize']);
  assert.deepEqual(triggers.repository_dispatch.types.slice().sort(), ['factory-sweep', 'factory-update-branch']);
  assert.deepEqual(triggers.push.branches, ['main']);
  assert.ok('schedule' in triggers && 'workflow_dispatch' in triggers);
});
