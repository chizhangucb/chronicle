// CHI #200: the choices the platform screenshot run makes.
//
// The run itself needs a Chromium and an installed tarball, so it lives on the
// CI runner (.github/workflows/platform-smoke.yml). What is pinned here is
// what it decides before it ever opens a browser, because each of those is a
// way the artifact comes back useless without the job going red: the font
// stack the glyphs are rendered in, the glyph set itself (read from
// spec/design-qa-rubric.md, so the sheet Chi inspects can never be a subset of
// what the app actually draws), which session is worth a Playback shot, and
// file names that do not collide when two OSes upload into one artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  monoStack,
  canonicalGlyphs,
  pickPlaybackSession,
  screenshotName,
  hintFault,
} from '../scripts/ci/platform-screenshots.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the mono stack is read out of the app CSS, not retyped', () => {
  const css = fs.readFileSync(path.join(REPO, 'src', 'styles.css'), 'utf8');
  assert.equal(monoStack(css), 'ui-monospace, "SF Mono", Menlo, monospace');
});

test('the mono stack survives a minified bundle, which is what ships', () => {
  assert.equal(monoStack('.a{color:red}:root{--mono:ui-monospace,"SF Mono",Menlo,monospace;--bg0:#111}'),
    'ui-monospace,"SF Mono",Menlo,monospace');
});

test('CSS with no --mono token is an error, not a silent default', () => {
  assert.equal(monoStack(':root{--bg0:#111}'), null);
});

test('the glyph sheet renders the canonical set from the design QA rubric', () => {
  const rubric = fs.readFileSync(path.join(REPO, 'spec', 'design-qa-rubric.md'), 'utf8');
  const glyphs = canonicalGlyphs(rubric);

  // The set as the rubric holds it today (ticket #200). Every one of these is
  // drawn in chrome or on a Playback row, and none of the named faces in the
  // mono stack ships on Windows or Linux, so each is a tofu candidate.
  const expected = ['⌕', '⧖', '◫', '▤', '⬚', '◈', '∑', '⚙', '⌫', '✕', '⛓',
    '↶', '↷', '↧', '⇩', '⊙', '✳', '⋯', '⇥', '↩', '＋'];
  // Set equality, not inclusion: a glyph added to the rubric without a look at
  // the next artifact is exactly the drift this guards, and the rubric itself
  // says to extend its list rather than start a parallel vocabulary.
  assert.deepEqual(glyphs, expected);
  // The two the ticket calls out as likeliest to land as tofu.
  assert.ok(glyphs.includes('⬚') && glyphs.includes('◫'), 'the two prime tofu suspects must be on the sheet');

  // One code point each, nothing ASCII: a parse that dragged in `=search` or a
  // whole phrase would render a sheet nobody can read a verdict off.
  for (const g of glyphs) {
    assert.equal([...g].length, 1, `not a single glyph: ${JSON.stringify(g)}`);
    assert.ok(g.codePointAt(0) > 0x7f, `ASCII on the glyph sheet: ${JSON.stringify(g)}`);
  }
  assert.equal(new Set(glyphs).size, glyphs.length, 'the sheet repeats a glyph');
});

test('the Playback shot goes to the session with the most to show', () => {
  const sessions = [
    { id: 'tiny', message_count: 3 },
    { id: 'big', message_count: 412 },
    { id: 'middling', message_count: 58 },
  ];
  assert.equal(pickPlaybackSession(sessions).id, 'big');
  // A missing count must not beat a real one.
  assert.equal(pickPlaybackSession([{ id: 'unknown', message_count: null }, { id: 'small', message_count: 2 }]).id, 'small');
  assert.equal(pickPlaybackSession([]), null);
});

test('screenshot names carry the OS, so two runners cannot overwrite each other', () => {
  assert.equal(screenshotName('sidebar', 'win32'), 'sidebar-win32.png');
  assert.equal(screenshotName('playback', 'linux'), 'playback-linux.png');
  assert.notEqual(screenshotName('glyphs', 'win32'), screenshotName('glyphs', 'linux'));
});

// ---- The keyboard hint in the Playback frame (issue #366).
//
// The Playback shot frames the session toolbar, and the search field there
// carries a shortcut hint. That hint used to read `⌘F` on every OS, naming a
// key a Windows or Linux keyboard does not have, and the first Windows
// screenshot from this very run is where it was caught. A picture only tells
// a human, so the run now reads the rendered hint and refuses to file a shot
// that shows the wrong key.
test('a Windows or Linux shot has to show the Control form', () => {
  assert.equal(hintFault('Search messages…  Ctrl+F', 'F', 'win32'), null);
  assert.equal(hintFault('Search messages…  Ctrl+F', 'F', 'linux'), null);
  assert.match(hintFault('Search messages…  ⌘F', 'F', 'win32'), /Ctrl\+F/);
  assert.match(hintFault('Search messages…  ⌘F', 'F', 'linux'), /Ctrl\+F/);
});

test('a macOS shot has to show the Command form', () => {
  assert.equal(hintFault('Search messages…  ⌘F', 'F', 'darwin'), null);
  assert.match(hintFault('Search messages…  Ctrl+F', 'F', 'darwin'), /⌘F/);
});

test('a hint naming BOTH modifiers is a fault too, not a pass on the substring', () => {
  // The half-fixed case: a surface that appends the Control form and leaves the
  // old symbol in place reads as two shortcuts, and would slip past a check
  // that only looked for what it expected.
  assert.match(hintFault('Search messages…  ⌘F / Ctrl+F', 'F', 'win32'), /⌘/);
  assert.match(hintFault('Search messages…  ⌘F / Ctrl+F', 'F', 'darwin'), /Ctrl/);
});

test('a field with no hint at all is a fault, not a silent pass', () => {
  // The shot is worth taking only while it still frames a hint: a placeholder
  // that lost it would otherwise retire this guard without a word.
  assert.match(hintFault('Search messages…', 'F', 'linux'), /Ctrl\+F/);
  assert.match(hintFault('', 'F', 'darwin'), /⌘F/);
});
