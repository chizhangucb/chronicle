// Unit tests for shared/synthetic.ts — the ONE "not a human turn" predicate
// (CHI-368). Pins that the exact leaked wrappers seen on the real-data walk are
// classified synthetic, and that a genuine prompt merely quoting a tag is NOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSyntheticUserText, SYNTHETIC_USER_RE } from '../shared/synthetic.ts';

test('isSyntheticUserText: true for every synthetic / IPC wrapper', () => {
  const synthetic = [
    // the two forms that leaked as session names on the CHI-324 phase-2 walk
    'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/86448.sock" from-name="chronicle-3f">hi</cross-session-message>',
    '<cross-session-message from="x">hi</cross-session-message>',
    '<command-message>grill-me</command-message> <command-name>/grill-me</command-name>',
    '<command-name>/rename</command-name>',
    '<task-notification>build finished</task-notification>',
    '<launch-selected-element>button</launch-selected-element>',
    '<system-reminder>context</system-reminder>',
    '<local-command-stdout>ok</local-command-stdout>',
    '[Request interrupted by user]',
    '   <system-reminder>leading whitespace still matches</system-reminder>',
  ];
  for (const text of synthetic) {
    assert.equal(isSyntheticUserText(text), true, `expected synthetic: ${text.slice(0, 40)}`);
    assert.equal(SYNTHETIC_USER_RE.test(text), true);
  }
});

test('isSyntheticUserText: false for genuine human prompts (incl. ones quoting a tag mid-sentence)', () => {
  const human = [
    'Please explore the repo',
    'why does the parser drop a <system-reminder> block? explain',
    'the docs mention <command-name> somewhere, find it',
    'Another approach: refactor the cross-session handler', // starts with "Another" but not the preamble
    'fix the <cross-session-message> rendering bug in the UI',
  ];
  for (const text of human) {
    assert.equal(isSyntheticUserText(text), false, `expected human: ${text.slice(0, 40)}`);
  }
});

test('isSyntheticUserText: false / safe for null / empty', () => {
  assert.equal(isSyntheticUserText(null), false);
  assert.equal(isSyntheticUserText(undefined), false);
  assert.equal(isSyntheticUserText(''), false);
});
