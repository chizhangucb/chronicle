// The triage-labels page, pinned against the factory that reads its labels.
//
// The page is a triager's only instruction sheet: it says which label to apply
// for each role and which one holds a ready ticket back. Both halves can rot
// without anything else in this repo noticing, and both did (#363). Before
// software-factory #210 the hold set was `needs-triage` and `ready-for-human`;
// now it is `hold` alone, so the page's old advice told a triager to apply the
// one label that no longer holds anything and the factory started the work.
//
// Chronicle cannot read GitHub's label list or the factory's modules from a
// test, so the two things this pin needs are written down below and widened by
// hand: REPO_LABELS is what `scripts/onboard.sh` created on this repo, and
// TRIAGER_LABELS_THE_FACTORY_READS is the part of that vocabulary a triager
// applies and `factory/dispatch/select.ts` acts on. Widening either is the step
// that says someone checked the factory and the repo, the same bargain
// test/factory-caller-inputs.test.mjs strikes with FACTORY_ROLES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/tracked-files.mjs';

const PAGE = 'docs/agents/triage-labels.md';
const source = read(PAGE);

// Every label chizhangucb/chronicle carries, by who writes it. The factory's
// `scripts/onboard.sh` creates all of them; naming one outside this set on the
// page sends a triager to `gh issue edit --add-label`, which fails on a label
// the repo does not have rather than creating it.
const REPO_LABELS = {
  // The five canonical triage roles, spelled identically to the factory's page.
  triageRoles: ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'],
  // A human's instruction, unprefixed because it is not factory state.
  human: ['hold'],
  // The factory's own state: it writes these, a triager does not.
  factoryState: [
    'agent:implement',
    'agent:in-progress',
    'agent:review',
    'agent:blocked',
    'needs-human',
    'factory:retry-1',
  ],
  categories: ['bug', 'enhancement'],
  wayfinder: [
    'wayfinder:map',
    'wayfinder:research',
    'wayfinder:prototype',
    'wayfinder:grilling',
    'wayfinder:task',
  ],
};

// --- The role-to-label table ----------------------------------------------

/** The page's `| Role | Label | Meaning |` table, as rows of trimmed cells. */
const roleTable = () => {
  const rows = source
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
  const header = rows.findIndex(
    (cells) => cells.length === 3 && cells.map((c) => c.toLowerCase()).join('|') === 'role|label|meaning',
  );
  assert.notEqual(header, -1, `${PAGE} carries no \`| Role | Label | Meaning |\` table`);
  // The separator row (`| --- |`) is not a row of the table.
  return rows.slice(header + 1).filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
};

/** A cell's label string, unwrapped from its backticks: `hold` -> hold. */
const labelIn = (cell) => cell.replace(/`/g, '').trim();

test('the table maps every triage role to this repo\'s label string', () => {
  const byRole = new Map(roleTable().map((cells) => [labelIn(cells[0]), cells]));
  for (const role of REPO_LABELS.triageRoles) {
    const row = byRole.get(role);
    assert.ok(row, `the table has no row for the ${role} role`);
    assert.equal(labelIn(row[1]), role, `the ${role} row names a different label than the role`);
    assert.ok(row[2].length > 0, `the ${role} row says nothing about what the label means`);
  }
});

test('`hold` has its own row, and it is nobody\'s triage role', () => {
  const rows = roleTable();
  const held = rows.find((cells) => labelIn(cells[1]) === 'hold');
  assert.ok(held, 'the table has no `hold` row, so nothing on the page says how to hold a ticket back');
  assert.equal(
    labelIn(held[0]),
    'none',
    '`hold` is not one of the five triage roles; its Role cell says `none` on software-factory\'s page',
  );
  assert.match(
    held[2],
    /never dispatched, retried or requeued/i,
    'the `hold` row must say the factory never dispatches, retries or requeues a held subject',
  );
  assert.match(
    held[2],
    /close the PR/i,
    'the `hold` row must say it does not stop an open PR, and that closing the PR is what does',
  );
});
