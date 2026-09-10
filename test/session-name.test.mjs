// Unit test for shared/sessionName.ts — the ONE session display name, read by
// the server (activity's top session, Explore's group=session label) and by
// the client (Sessions tab, session picker, Overview title, search rows). The
// two used to be near-copies: the same name → summary → first prompt → id
// precedence, differing only in what the last rung looks like, which is now
// the `presentation` parameter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionDisplayName } from '../shared/sessionName.ts';

const ID = '3f2a1b9c-7d4e-4a11-9f00-abcdef123456';

test('sessionDisplayName: precedence is user-set name, then summary, then first prompt', () => {
  const row = { id: ID, name: 'Renamed by me', summary: 'Tool summary', first_prompt: 'fix the parser' };
  assert.equal(sessionDisplayName(row, 'id'), 'Renamed by me');
  assert.equal(sessionDisplayName({ ...row, name: null }, 'id'), 'Tool summary');
  assert.equal(sessionDisplayName({ ...row, name: null, summary: null }, 'id'), 'fix the parser');
});

test('sessionDisplayName: a synthetic first prompt is treated as absent, so a wrapper never becomes a name', () => {
  const row = {
    id: ID, name: null, summary: null,
    first_prompt: '<command-name>/rename</command-name>',
  };
  assert.equal(sessionDisplayName(row, 'id'), ID);
  assert.equal(sessionDisplayName(row, 'label'), 'Session 3f2a1b9c');
});

test('sessionDisplayName: the id presentation falls back to the whole session id', () => {
  assert.equal(sessionDisplayName({ id: ID, name: null, summary: null, first_prompt: null }, 'id'), ID);
});

test('sessionDisplayName: the label presentation falls back to a prefixed, shortened id', () => {
  assert.equal(sessionDisplayName({ id: ID, name: null, summary: null, first_prompt: null }, 'label'), 'Session 3f2a1b9c');
  // A row with no id at all reaches the client from a live session that has
  // not been stored yet; the label presentation still has something to render.
  assert.equal(sessionDisplayName({ name: null, summary: null, first_prompt: null }, 'label'), 'Session');
});

test('sessionDisplayName: a blank name or summary falls through instead of rendering as whitespace', () => {
  const row = { id: ID, name: '   ', summary: '', first_prompt: 'fix the parser' };
  assert.equal(sessionDisplayName(row, 'label'), 'fix the parser');
});
