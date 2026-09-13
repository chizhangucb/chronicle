// The two breadcrumb pickers' own module (issue #381).
//
// The Project picker and the Session picker were declared inside
// src/ProjectDetail.tsx, and the session view imported one of them across that
// page boundary. They take pure props already, so they moved wholesale into
// src/pickers/ and both pages import them from there.
//
// The dropdowns themselves are JSX, which `node --test` has no loader for, so
// the half that decides what a dropdown SHOWS — which rows a typed query
// keeps, how a row is titled and dated — lives in src/pickers/rows.ts and is
// asserted here directly. The placement pins at the bottom of this file cover
// the relocation itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ago, matchesProjectQuery, matchesSessionQuery, sessionPickerTitle,
} from '../src/pickers/rows.ts';

// Three projects as GET /api/projects returns them, the worked example for
// every project-filter assertion below.
const PROJECTS = [
  { id: 1, name: 'chronicle', path: '/Users/chi/code/chronicle' },
  { id: 2, name: 'Website', path: '/Users/chi/code/getchronicle.dev' },
  { id: 3, name: 'scratch', path: '/tmp/tomte-notes' },
];

const keptProjects = (q) => PROJECTS.filter((p) => matchesProjectQuery(p, q)).map((p) => p.name);

test('an empty query keeps every project row', () => {
  assert.deepEqual(keptProjects(''), ['chronicle', 'Website', 'scratch']);
});

test('a project matches on its name, ignoring case on both sides', () => {
  assert.deepEqual(keptProjects('WEBSITE'), ['Website']);
  assert.deepEqual(keptProjects('scr'), ['scratch']);
});

test('a project matches on its path too, so a folder name finds it', () => {
  assert.deepEqual(keptProjects('tomte'), ['scratch']);
  assert.deepEqual(keptProjects('/Users/chi'), ['chronicle', 'Website']);
});

test('a project with no path is still filtered on its name alone', () => {
  assert.equal(matchesProjectQuery({ id: 9, name: 'orphan' }, 'orph'), true);
  assert.equal(matchesProjectQuery({ id: 9, name: 'orphan' }, '/tmp'), false);
});

test('a project matching nothing is dropped', () => {
  assert.deepEqual(keptProjects('zzz'), []);
});

// Sessions as GET /api/projects/:id embeds them: the display name comes from
// shared/sessionName.ts, so a row with no name/summary/prompt is titled from
// its id (`Session 3f2a1b9c`).
const SESSIONS = [
  { id: 'aaaa1111bbbb2222', summary: 'Fix the import wizard' },
  { id: 'cccc3333dddd4444', first_prompt: 'Add a Spend tab' },
  { id: '3f2a1b9c99887766' },
];

const keptSessions = (q) => SESSIONS.filter((s) => matchesSessionQuery(s, q)).map((s) => s.id);

test('an empty query keeps every session row', () => {
  assert.deepEqual(keptSessions(''), ['aaaa1111bbbb2222', 'cccc3333dddd4444', '3f2a1b9c99887766']);
});

test('a session matches on the title the row renders, ignoring case', () => {
  assert.deepEqual(keptSessions('SPEND'), ['cccc3333dddd4444']);
  assert.deepEqual(keptSessions('wizard'), ['aaaa1111bbbb2222']);
});

test('a session matches on its id, so pasting an id finds that one session', () => {
  assert.deepEqual(keptSessions('dddd4444'), ['cccc3333dddd4444']);
  // The id-titled row is findable by either half: its label shows the first
  // eight characters, its id carries the rest.
  assert.deepEqual(keptSessions('99887766'), ['3f2a1b9c99887766']);
});

test('an id search is case-sensitive where a title search is not', () => {
  assert.deepEqual(keptSessions('DDDD4444'), []);
});

test('a session matching nothing is dropped', () => {
  assert.deepEqual(keptSessions('zzz'), []);
});

// The title is the shared display name (shared/sessionName.ts), cut to the
// width the dropdown row has.
test('a session row is titled by the shared display name', () => {
  assert.equal(sessionPickerTitle({ id: 'aaaa1111bbbb2222', summary: 'Fix the import wizard' }), 'Fix the import wizard');
  assert.equal(sessionPickerTitle({ id: '3f2a1b9c99887766' }), 'Session 3f2a1b9c');
});

test('a long session title is truncated to the row width', () => {
  const long = { id: 'a', summary: 'x'.repeat(80) };
  assert.equal(sessionPickerTitle(long), 'x'.repeat(48));
});

// The "when" a picker row shows: days only, which is all either dropdown has
// room for.
const NOW = Date.parse('2026-09-13T12:00:00Z');

test('a row from today reads "today", not "0 days ago"', () => {
  assert.equal(ago('2026-09-13T09:00:00Z', NOW), 'today');
});

test('a row from yesterday reads in the singular', () => {
  assert.equal(ago('2026-09-12T09:00:00Z', NOW), '1 day ago');
});

test('an older row counts whole days', () => {
  assert.equal(ago('2026-09-06T12:00:00Z', NOW), '7 days ago');
  assert.equal(ago('2026-06-15T12:00:00Z', NOW), '90 days ago');
});

// --- The relocation itself -------------------------------------------------
//
// Source pins, not renders: these two are .tsx, and `npm test` has no JSX
// loader, so the same shape test/client-twins-removed.test.mjs and
// test/tool-labels-single-home.test.mjs use is what pins a client widget's
// home here.
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

const sourceOf = (rel) => SOURCES.find((s) => s.rel === rel).text;

const PICKERS_HOME = path.join('src', 'pickers', 'Pickers.tsx');

test('each picker is declared exactly once, in src/pickers/Pickers.tsx', () => {
  for (const name of ['ProjectPicker', 'SessionPicker']) {
    const declares = SOURCES
      .filter(({ text }) => new RegExp(`(?:function|const)\\s+${name}\\b`).test(text))
      .map(({ rel }) => rel);
    assert.deepEqual(declares, [PICKERS_HOME], `${name} should be declared only in ${PICKERS_HOME}`);
  }
});

test('the project page mounts both pickers out of that one module', () => {
  const text = sourceOf(path.join('src', 'ProjectDetail.tsx'));
  assert.match(text, /import \{[^}]*\bProjectPicker\b[^}]*\} from '\.\/pickers\/Pickers\.tsx'/);
  assert.match(text, /import \{[^}]*\bSessionPicker\b[^}]*\} from '\.\/pickers\/Pickers\.tsx'/);
});

test('the session view mounts the session picker out of that one module', () => {
  const text = sourceOf(path.join('src', 'SessionView.tsx'));
  assert.match(text, /import \{[^}]*\bSessionPicker\b[^}]*\} from '\.\/pickers\/Pickers\.tsx'/);
});

test('no module re-exports a picker, so there is one spelling of the import', () => {
  const reExports = SOURCES
    .filter(({ rel }) => rel !== PICKERS_HOME)
    .filter(({ text }) => /export\s*(?:type\s*)?\{[^}]*\b(?:ProjectPicker|SessionPicker)\b[^}]*\}/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(reExports, [], 'a re-export is a second home wearing the first one\'s clothes');
});
