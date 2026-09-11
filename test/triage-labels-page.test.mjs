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
// hand: REPO_LABELS is what the factory's `scripts/onboard.sh` created on this
// repo, and TRIAGER_LABELS_THE_FACTORY_READS is the part of that vocabulary a
// triager applies and `factory/dispatch/select.ts` acts on. Widening either is
// the step that says someone checked the factory and the repo, the same bargain
// test/factory-caller-inputs.test.mjs strikes with FACTORY_ROLES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, flatten } from './helpers/tracked-files.mjs';

const PAGE = 'docs/agents/triage-labels.md';
const source = read(PAGE);
const flat = flatten(source);

/** The five canonical triage roles, spelled identically to their label strings. */
const TRIAGE_ROLES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

// Every label chizhangucb/chronicle carries. The factory's `scripts/onboard.sh`
// creates all of them; naming one outside this set on the page sends a triager
// to `gh issue edit --add-label`, which fails on a label the repo does not have
// rather than creating it.
const REPO_LABELS = new Set([
  ...TRIAGE_ROLES,
  // A human's instruction, unprefixed because it is not factory state.
  'hold',
  // The factory's own state: it writes these, a triager does not.
  'agent:implement',
  'agent:in-progress',
  'agent:review',
  'agent:blocked',
  'needs-human',
  'factory:retry-1',
  // The two triage categories.
  'bug',
  'enhancement',
  // The five wayfinder ticket types.
  'wayfinder:map',
  'wayfinder:research',
  'wayfinder:prototype',
  'wayfinder:grilling',
  'wayfinder:task',
]);

// --- The role-to-label table ----------------------------------------------

/** The page's `| Role | Label | Meaning |` table, as rows of trimmed cells. */
const roleTable = () => {
  // The first run of `|` lines only: a second table elsewhere on the page is
  // not this table, and its rows must not answer for it.
  const lines = source.split('\n').map((line) => line.trim());
  const first = lines.findIndex((line) => line.startsWith('|'));
  const after = lines.findIndex((line, i) => i > first && !line.startsWith('|'));
  const rows = lines
    .slice(Math.max(first, 0), after === -1 ? lines.length : after)
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
  const header = rows.findIndex(
    (cells) => cells.length === 3 && cells.map((cell) => cell.toLowerCase()).join('|') === 'role|label|meaning',
  );
  assert.notEqual(header, -1, `${PAGE} carries no \`| Role | Label | Meaning |\` table`);
  // The separator row (`| --- |`) is not a row of the table.
  return rows.slice(header + 1).filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
};

/** A cell's label string, unwrapped from its backticks: `hold` -> hold. */
const labelIn = (cell) => cell.replace(/`/g, '').trim();

test("the table maps every triage role to this repo's label string", () => {
  const byRole = new Map(roleTable().map((cells) => [labelIn(cells[0]), cells]));
  for (const role of TRIAGE_ROLES) {
    const row = byRole.get(role);
    assert.ok(row, `the table has no row for the ${role} role`);
    assert.equal(labelIn(row[1]), role, `the ${role} row names a different label than the role`);
    assert.ok(row[2].length > 0, `the ${role} row says nothing about what the label means`);
  }
});

test("`hold` has its own row, and it is nobody's triage role", () => {
  const held = roleTable().find((cells) => labelIn(cells[1]) === 'hold');
  assert.ok(held, 'the table has no `hold` row, so nothing on the page says how to hold a ticket back');
  assert.equal(
    labelIn(held[0]),
    'none',
    "`hold` is not one of the five triage roles; its Role cell says `none` on software-factory's page",
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

// The labels a TRIAGER applies that the factory then acts on, so the page
// omitting one leaves a triager with no way to say that thing at all:
//   ready-for-agent  `READY_LABEL`: the dispatcher starts on nothing else.
//   hold             `HOLD_LABELS`, which since software-factory #210 is this
//                    label alone. Before it people held tickets with
//                    `needs-triage`, and a triage pass that cleared the pair as
//                    drift released 12 tickets at once (their #169).
// The rest of what the factory reads (`agent:*`, `needs-human`,
// `factory:retry-1`) is factory state it writes itself and a triager never
// applies, which is why software-factory's own page of this name lists none of
// it. Move a label here the day a triager is told to apply it by hand.
const TRIAGER_LABELS_THE_FACTORY_READS = ['ready-for-agent', 'hold'];

// Unambiguously a label wherever it appears, backticks or not: the factory's
// three namespaces and the two role families. Ordinary hyphenated prose ("it
// re-scans every ticket") is not in this shape, and a reader typing a bare
// needs-triaged into `gh issue edit` hits the same failure as a backticked one.
const LABEL_FAMILIES = /^(?:agent|factory|wayfinder):[a-z0-9-]+$|^(?:needs|ready)-[a-z0-9-]+$/;

/** Every token on the page that reads as a label to whoever follows it. */
const labelsNamedOnThePage = () => {
  const words = (text) => text.split(/[\s|+,;()"']+/).filter(Boolean);
  // A backticked span that is one word counts whole, unhyphenated ones
  // included: code voice on this page means a label, which is how a bare
  // `wontfix` typo is caught. A path (`factory/dispatch/select.ts`) and a
  // slash command (`/triage`) are the two single-word spans here that are
  // plainly not labels. A span of several words is a command, not a label
  // (`gh issue edit --add-label hold`); its own words are not each a label,
  // and any label inside it is still caught by the bare pass below, which
  // reads the page with the backticks stripped out.
  const backticked = [...source.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1].trim())
    .filter((span) => !/\s/.test(span))
    .filter((token) => !token.includes('/') && !token.includes('.'))
    .filter((token) => /^[a-z][a-z0-9]*(?:[:-][a-z0-9]+)*$/.test(token));
  // Bare in prose, only the label families, stripped of sentence punctuation.
  const bare = words(source.replace(/`/g, ' '))
    .map((token) => token.replace(/[.,;:!?)"']+$/, ''))
    .filter((token) => LABEL_FAMILIES.test(token));
  return [...new Set([...backticked, ...bare])];
};

test('the page names no label this repo does not have', () => {
  // A triager follows the page into `gh issue edit --add-label <name>`, which
  // fails on a label the repo does not carry rather than creating one.
  const unknown = labelsNamedOnThePage().filter((label) => !REPO_LABELS.has(label));
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

// Each of these was true before software-factory #210 and is false now: the
// hold set is `hold` alone, so a ticket carrying `needs-triage` +
// `ready-for-agent` is dispatched, not held. A triager following any of them
// picks the label that no longer stops anything and the factory starts work.
const RETIRED_CLAIMS = [
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
  {
    // Since #365 the caller ignores the factory's own `agent:*` and `factory:*`
    // removals (a run's cleanup would otherwise wake a sweep that re-stamps the
    // ticket it just finished) and ignores any label edit on a closed ticket.
    // "Removing any label triggers a sweep" now sends a reader looking for a
    // sweep that never comes.
    claim: 'every label removal triggers a sweep',
    re: /removing any label[^.]{0,60}\b(triggers|wakes)\b|no quiet label removal/i,
  },
];

for (const { claim, re } of RETIRED_CLAIMS) {
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
// reaches them. Key phrase only, not the sentence: rewording the paragraph is
// somebody's to do, losing the claim is not.
const WAYFINDER_CLAIMS = [
  { claim: 'readiness on a wayfinder ticket is structural, not a label', re: /structural rather than a label/i },
  { claim: 'only wayfinder:task carries a readiness label', re: /only wayfinder:task carries a readiness label/i },
  { claim: 'wayfinder:grilling and wayfinder:prototype stay unlabelled', re: /wayfinder:\w+ and wayfinder:\w+[^.]*stay unlabelled/i },
];

/** The wayfinder half alone, so a claim that fell out of it cannot pass on a stray mention. */
const wayfinderSection = () => {
  const start = source.indexOf('## Wayfinder tickets');
  assert.notEqual(start, -1, `${PAGE} lost its wayfinder section, which #363 was not to touch`);
  return flatten(source.slice(start));
};

for (const { claim, re } of WAYFINDER_CLAIMS) {
  test(`the page still says "${claim}"`, () => {
    assert.match(wayfinderSection(), re, `${PAGE} lost a wayfinder claim the triage rewrite was not meant to touch`);
  });
}
