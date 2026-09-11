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

// --- The claims software-factory #210 retired ------------------------------

// Prose wraps and markdown bolds half a sentence, so a claim is matched against
// the flattened page, the same way test/local-first-promise.test.mjs matches
// its overclaims.
const flat = source.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

// Each of these was true before software-factory #210 and is false now: the
// hold set is `hold` alone, so a ticket carrying `needs-triage` +
// `ready-for-agent` is dispatched, not held. A triager following any of them
// picks the label that no longer stops anything and the factory starts work.
const RETIRED = [
  {
    claim: 'needs-triage or ready-for-human is a brake',
    re: /(needs-triage|ready-for-human)[^.]{0,80}\b(are|is) (a )?(holds?|brakes?)\b/i,
  },
  {
    claim: 'the factory refuses a ticket for its triage role',
    re: /factory refuses[^.]{0,80}\b(needs-triage|ready-for-human|carrying one)\b/i,
  },
  {
    claim: 'needs-triage + ready-for-agent is a legitimate pair',
    re: /needs-triage \+ ready-for-agent|ready-for-agent \+ needs-triage/i,
  },
  { claim: 'a ticket can be agent-ready but held by its triage role', re: /agent-ready but held/i },
];

for (const { claim, re } of RETIRED) {
  test(`the page no longer claims "${claim}"`, () => {
    const hit = flat.match(re);
    assert.equal(
      hit,
      null,
      `${PAGE} still says it: "${hit?.[0]}". Since software-factory #210 the hold set is \`hold\` ` +
        'alone, so this sends a triager to a label that holds nothing',
    );
  });
}

// --- The maintainer's rule, stated once ------------------------------------

test('the page says needs-triage means a human still has to decide', () => {
  assert.match(
    flat,
    /needs-triage means a human [^.]{0,60}\bdecide\b/i,
    `${PAGE} must say what \`needs-triage\` asks for. Without it the label reads as a state a ` +
      'triager clears rather than a decision a human owes, which is how it became a hold in the first place',
  );
});

test('the page says hold is how a finished ticket is held', () => {
  assert.match(
    flat,
    /holding a (finished|ready) ticket is hold\b/i,
    `${PAGE} must name the label that actually holds a ticket back, beside the one that does not`,
  );
});

// --- The wayfinder guidance this rewrite must not eat -----------------------

// #363 rewrote the triage half of this page and left the wayfinder half alone.
// These are that half's three claims, pinned so the next rewrite of the table
// above cannot take them with it. They are about readiness on a wayfinder
// ticket, which no label decides, so nothing software-factory #210 changed
// reaches them.
const WAYFINDER_CLAIMS = [
  {
    claim: 'readiness on a wayfinder ticket is structural, not a label',
    re: /readiness here is structural rather than a label[^.]*open, has no open blockers and has no assignee/i,
  },
  {
    claim: 'only wayfinder:task carries a readiness label',
    re: /only wayfinder:task carries a readiness label: ready-for-agent[^.]*ready-for-human/i,
  },
  {
    claim: 'wayfinder:grilling and wayfinder:prototype stay unlabelled',
    re: /wayfinder:grilling and wayfinder:prototype[^.]*stay unlabelled/i,
  },
];

for (const { claim, re } of WAYFINDER_CLAIMS) {
  test(`the page still says "${claim}"`, () => {
    assert.match(flat, re, `${PAGE} lost a wayfinder claim the triage rewrite was not meant to touch`);
  });
}
