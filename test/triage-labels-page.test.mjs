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

// --- The vocabulary the page is allowed to name ---------------------------

const EVERY_REPO_LABEL = new Set(Object.values(REPO_LABELS).flat());

// The labels a TRIAGER applies that the factory then acts on, so the page
// omitting one leaves a triager with no way to say that thing at all:
//   ready-for-agent  `READY_LABEL`: the dispatcher starts on nothing else.
//   hold             `HOLD_LABELS`, which since software-factory #210 is this
//                    label alone. Before it people held tickets with
//                    `needs-triage`, and a triage pass that cleared the pair as
//                    drift released 12 tickets at once (their #169).
// The rest of what the factory reads (`agent:*`, `needs-human`,
// `factory:retry-1`) is factory state it writes itself, which is why
// software-factory's own page of this name lists none of it.
const TRIAGER_LABELS_THE_FACTORY_READS = ['ready-for-agent', 'hold'];

// A backticked token is read as a label unless it is plainly something else: a
// path (`factory/dispatch/select.ts`) or a slash command (`/triage`). Anything
// else lowercase-and-kebab looks exactly like a label to whoever reads this
// page, which is the point of the check.
const backtickedLabels = () =>
  [...source.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((token) => !token.includes('/') && !token.includes('.'))
    .filter((token) => /^[a-z][a-z0-9]*(?:[:-][a-z0-9]+)*$/.test(token));

test('the page names no label this repo does not have', () => {
  // A triager follows the page into `gh issue edit --add-label <name>`, which
  // fails on a label the repo does not carry rather than creating one.
  const unknown = [...new Set(backtickedLabels())].filter((label) => !EVERY_REPO_LABEL.has(label));
  assert.deepEqual(
    unknown,
    [],
    `${PAGE} names a label chizhangucb/chronicle does not have. Create it via the factory's ` +
      `scripts/onboard.sh and add it to REPO_LABELS, or fix the spelling:\n  ${unknown.join('\n  ')}`,
  );
});

test('the table names every label a triager applies that the factory reads', () => {
  const listed = roleTable().map((cells) => labelIn(cells[1]));
  const missing = TRIAGER_LABELS_THE_FACTORY_READS.filter((label) => !listed.includes(label));
  assert.deepEqual(
    missing,
    [],
    `${PAGE} is a triager's only instruction sheet, and the factory acts on these: ` +
      `omitting one leaves no way to say that thing\n  ${missing.join('\n  ')}`,
  );
});
