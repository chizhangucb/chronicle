// The friendly tool-label map has one home (issue #375, prefactor for #374).
//
// The lookup that turns a raw tool name into a display label (`Bash` →
// "Shell Command") was written twice: once in src/session/stats.ts for the
// session Overview's tool-mix bars and call timeline, once in
// src/ProjectDetail.tsx for the project Overview's call ranking. Two copies
// is one place for a tool to end up named two different ways on two
// surfaces, so the map now lives in src/toolLabels.ts and every caller
// imports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRIENDLY_CALL } from '../src/toolLabels.ts';

// The labels as the two surfaces render them today — a known-good literal,
// not a re-derivation of the map.
test('the map labels each raw tool name the way the surfaces already do', () => {
  assert.deepEqual(FRIENDLY_CALL, {
    Bash: 'Shell Command',
    Write: 'Write File',
    Edit: 'Edit File',
    Read: 'Read File',
    Skill: 'Skill Invoke',
    Grep: 'Search',
    Glob: 'Search',
    WebFetch: 'Web Fetch',
    WebSearch: 'Web Search',
  });
});

test('a tool with no friendly label is absent, so callers fall back to the raw name', () => {
  assert.equal(FRIENDLY_CALL.TodoWrite, undefined);
  assert.equal(FRIENDLY_CALL[''], undefined);
});

// The pins below are the removal half: the behaviour above is only single if
// there is nowhere for a second copy to live.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SOURCES = [...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared')]
  .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

test('the map is declared exactly once, in src/toolLabels.ts', () => {
  const declares = SOURCES
    .filter(({ text }) => /(?:^|\n)\s*(?:export )?const FRIENDLY_CALL\b/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(declares, ['src/toolLabels.ts'], 'FRIENDLY_CALL should be declared only in src/toolLabels.ts');
});

test('no module re-exports the map, so there is one spelling of the import', () => {
  const reExports = SOURCES
    .filter(({ rel }) => rel !== 'src/toolLabels.ts')
    .filter(({ text }) => /export\s*\{[^}]*\bFRIENDLY_CALL\b[^}]*\}/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(reExports, [], 'a re-export is a second home wearing the first one\'s clothes');
});

// The two surfaces that label tools today. Each reaches for the shared map
// rather than a local one, so the labels they render stay identical.
test('both label callers import the map from its one home', () => {
  for (const rel of ['src/session/OverviewMode.tsx', 'src/ProjectDetail.tsx']) {
    const text = SOURCES.find((s) => s.rel === rel).text;
    assert.match(text, /import \{ FRIENDLY_CALL \} from '\.[./]*\/?toolLabels\.ts'/,
      `${rel} should import FRIENDLY_CALL from src/toolLabels.ts`);
    assert.match(text, /FRIENDLY_CALL\[/, `${rel} should still label tools through the map`);
  }
});
