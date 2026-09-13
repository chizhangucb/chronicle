// The friendly tool-label map has one home (issue #375, prefactor for #374).
//
// The lookup that turns a raw tool name into a display label (`Bash` into
// "Shell Command") was written twice: once in src/session/stats.ts for the
// session Overview's tool-mix bars and call timeline, once in
// src/ProjectDetail.tsx for the project Overview's call ranking. Two copies
// is one place for a tool to end up named two different ways on two
// surfaces, so the map now lives in src/toolLabels.ts and every caller reads
// it through that module's one lookup, the way src/kinds.ts already owns the
// chat-type labels. The project-side caller is the Overview's aggregator
// (src/analytics/projectAggregates.ts) since #376 moved that page's
// number-assembly out of the component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { friendlyToolLabel } from '../src/toolLabels.ts';

// The labels as the two surfaces render them today, a known-good literal
// rather than a re-derivation of the map. Asserted entry by entry, so adding
// a label for a tool that has none yet is not a failure: what must not change
// is what these nine already render as.
const RENDERED_TODAY = [
  ['Bash', 'Shell Command'],
  ['Write', 'Write File'],
  ['Edit', 'Edit File'],
  ['Read', 'Read File'],
  ['Skill', 'Skill Invoke'],
  ['Grep', 'Search'],
  ['Glob', 'Search'],
  ['WebFetch', 'Web Fetch'],
  ['WebSearch', 'Web Search'],
];

test('the map labels each raw tool name the way the surfaces already do', () => {
  for (const [raw, label] of RENDERED_TODAY) {
    assert.equal(friendlyToolLabel(raw), label, `${raw} should still render as "${label}"`);
  }
});

// No entry means no friendly spelling: the raw name comes back unchanged and
// what a surface does with it is the surface's own business (the project
// ranking buckets an over-long one as "Other"), so the map must not invent one.
test('a tool with no friendly label keeps its raw name, leaving the fallback to the caller', () => {
  assert.equal(friendlyToolLabel('TodoWrite'), 'TodoWrite');
  assert.equal(friendlyToolLabel(''), '');
  assert.equal(friendlyToolLabel(null), '');
  // Own-key only: an Object.prototype key is a tool name like any other, not a
  // function handed back to a caller that is about to render it.
  assert.equal(friendlyToolLabel('constructor'), 'constructor');
});

// The pins below are the removal half: one home only holds if there is
// nowhere for a second copy to live. The same shape as
// test/client-twins-removed.test.mjs and test/commit-count-single-home.test.mjs.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// server/ and shared/ are swept too, not just the client: a copy reinstated
// on the far side of the wire would drift from the client's labels exactly
// the same way the two client copies could.
const SOURCES = [...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared')]
  .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

test('the map is declared exactly once, in src/toolLabels.ts', () => {
  const declares = SOURCES
    .filter(({ text }) => /(?:^|\n)\s*(?:export )?const TOOL_LABEL\b/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(declares, ['src/toolLabels.ts'], 'TOOL_LABEL should be declared only in src/toolLabels.ts');
});

test('no module re-exports the map, so there is one spelling of the import', () => {
  const reExports = SOURCES
    .filter(({ rel }) => rel !== 'src/toolLabels.ts')
    .filter(({ text }) => /export\s*(?:type\s*)?\{[^}]*\b(?:TOOL_LABEL|friendlyToolLabel)\b[^}]*\}/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(reExports, [], 'a re-export is a second home wearing the first one\'s clothes');
});

// The two surfaces that label tools today. Each reaches for the shared map
// rather than a local one, so the labels they render stay identical.
test('both label callers reach the map through its one home', () => {
  for (const rel of ['src/session/OverviewMode.tsx', 'src/analytics/projectAggregates.ts']) {
    const text = SOURCES.find((s) => s.rel === rel).text;
    assert.match(text, /import \{[^}]*\bfriendlyToolLabel\b[^}]*\} from '[./]*toolLabels\.ts'/,
      `${rel} should import friendlyToolLabel from src/toolLabels.ts`);
    assert.match(text, /friendlyToolLabel\(/, `${rel} should still label tools through the map`);
  }
});
