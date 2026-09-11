// The keyboard-hint modifier (issue #366).
//
// Every shortcut handler in the client accepts Command OR Control, but every
// hint was written with the Command symbol, so a Windows or Linux visitor read
// the name of a key their keyboard does not have. src/shortcuts.ts is the one
// place that decides which modifier a platform uses; these pins hold both of
// its answers without a browser, which is the only way `npm test` can reach a
// question about `navigator`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutHint } from '../src/shortcuts.ts';
import { tracked, read, BINARY } from './helpers/tracked-files.mjs';

const HELPER = 'src/shortcuts.ts';

test('macOS reads the Command symbol', () => {
  assert.equal(shortcutHint('K', { platform: 'MacIntel' }), '⌘K');
});

test('Windows and Linux read Control, the key those keyboards have', () => {
  assert.equal(shortcutHint('K', { platform: 'Win32' }), 'Ctrl+K');
  assert.equal(shortcutHint('K', { platform: 'Windows' }), 'Ctrl+K');
  assert.equal(shortcutHint('K', { platform: 'Linux x86_64' }), 'Ctrl+K');
});

test('every name macOS goes by carries the Command symbol', () => {
  // `navigator.platform` (MacIntel), `userAgentData.platform` (macOS), the user
  // agent string (Macintosh) and `process.platform` (darwin) are four different
  // words for the one keyboard that has a Command key.
  for (const mac of ['MacIntel', 'macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'darwin']) {
    assert.equal(shortcutHint('F', { platform: mac }), '⌘F', mac);
  }
});

test('a Shift chord spells out on Windows and Linux, and stacks symbols on macOS', () => {
  assert.equal(shortcutHint('U', { shift: true, platform: 'MacIntel' }), '⇧⌘U');
  assert.equal(shortcutHint('U', { shift: true, platform: 'Win32' }), 'Ctrl+Shift+U');
});

test('a host that names no platform reads as Control, never as a key it cannot name', () => {
  // The fallback for a host that says nothing about itself is the modifier
  // every keyboard has.
  assert.equal(shortcutHint('1', { platform: '' }), 'Ctrl+1');
  // Node DOES carry a browser-shaped `navigator.platform` ('MacIntel',
  // 'Win32', 'Linux x86_64'), so the no-argument answer follows the machine
  // running the pins rather than a fixed string — asserting 'Ctrl+1' flat would
  // fail `npm test` on every Mac.
  assert.equal(shortcutHint('1'), process.platform === 'darwin' ? '⌘1' : 'Ctrl+1');
});

// ---- The sweep: one place owns the symbol.
//
// The bug was not one wrong string, it was seventeen hand-written ones. A pin
// on the helper alone would leave the next hint free to type `⌘` again, so the
// client is swept: the Command and Shift symbols live in src/shortcuts.ts and
// nowhere else under src/, comments and stylesheet included.
test('no surface writes a modifier symbol itself', () => {
  const offenders = [];
  for (const rel of tracked.filter((p) => p.startsWith('src/') && !BINARY.test(p))) {
    if (rel === HELPER) continue;
    read(rel).split('\n').forEach((line, i) => {
      if (/[⌘⇧]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `the modifier symbol belongs in ${HELPER}:\n${offenders.join('\n')}`);
});

test('the helper is the one place the symbol is written', () => {
  assert.match(read(HELPER), /⌘/);
});

// ---- The other half of the promise the hints make.
//
// A hint that reads `Ctrl+K` off macOS is only true while the handler behind it
// takes Control as well as Command. This ticket changed labels and nothing else
// (issue #366), so the pairing is held here rather than left to the diff: every
// line in the client that consults one of the two modifiers consults both.
test('every shortcut handler still accepts either modifier', () => {
  const lonely = [];
  for (const rel of tracked.filter((p) => /^src\/.*\.tsx?$/.test(p))) {
    read(rel).split('\n').forEach((line, i) => {
      if (line.includes('metaKey') !== line.includes('ctrlKey')) lonely.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(lonely, [], `a shortcut reachable with only one modifier:\n${lonely.join('\n')}`);
});
