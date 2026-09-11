// The chat-type glyph pins for src/kinds.ts and the Playback row that draws them.
//
// KIND_ICON is the single source of truth for the marker in front of a message
// kind. Three of its six entries sat outside the app's mono-glyph vocabulary —
// user/thinking/tool_use were colored emoji (issue #204) — so these pins hold
// the vocabulary rule at the map itself, not only at the repo-wide sweep in
// test/no-colored-emoji.test.mjs. What counts as colored is defined once, in
// test/helpers/colored-emoji.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_ICON, KIND_LABEL } from '../src/kinds.ts';
import { metaFor } from '../src/session/kindMeta.ts';
import { COLORED_EMOJI } from './helpers/colored-emoji.mjs';
import { readSource } from './helpers/read-source.mjs';

test('KIND_ICON: every kind carries a monochrome glyph', () => {
  for (const [kind, icon] of Object.entries(KIND_ICON)) {
    assert.ok(icon.length > 0, `${kind} has no icon`);
    assert.equal(COLORED_EMOJI.test(icon), false, `${kind} icon ${icon} is a colored emoji`);
  }
});

test('KIND_ICON: covers exactly the display kinds KIND_LABEL names', () => {
  assert.deepEqual(Object.keys(KIND_ICON).sort(), Object.keys(KIND_LABEL).sort());
});

test('KIND_ICON: one glyph per kind, never shared', () => {
  const icons = Object.values(KIND_ICON);
  assert.equal(new Set(icons).size, icons.length, `duplicate glyph in ${icons.join(' ')}`);
});

// The Playback row's own resolution step, lifted out of MessageRow.tsx so it is
// reachable without a DOM: the row draws `metaFor(m.kind).icon` in front of the
// tool name or the kind label. Node cannot import a .tsx, so a glyph that
// reached the row wrong could otherwise only be caught by the e2e suite.
test('playback rows resolve every kind to its canonical mono glyph', () => {
  for (const kind of Object.keys(KIND_LABEL)) {
    const meta = metaFor(kind);
    assert.equal(meta.icon, KIND_ICON[kind], `${kind} row icon`);
    assert.equal(meta.label, KIND_LABEL[kind], `${kind} row label`);
    assert.equal(COLORED_EMOJI.test(meta.icon), false, `${kind} row icon is a colored emoji`);
    assert.ok(meta.cls.length > 0, `${kind} has no row class`);
  }
});

test('playback rows fall back to a mono bullet for an unknown kind', () => {
  const meta = metaFor('summary');
  assert.equal(meta.icon, '•');
  assert.equal(meta.label, 'summary');
  assert.equal(meta.cls, '');
});

// The last link the unit pin above cannot reach: that the row actually draws
// what metaFor resolved. Read off disk, because the assertion is about the .tsx
// source Node cannot import.
test('MessageRow draws the resolved glyph and declares no kind glyph of its own', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/session/MessageRow.tsx');
  const src = readSource(file);
  assert.match(src, /const meta: KindMeta = metaFor\(m\.kind\);/,
    'MessageRow no longer resolves its row chrome through metaFor');
  assert.match(src, /className="msg-kind">\{meta\.icon\}/,
    'the kind head no longer draws the resolved glyph');
  for (const [kind, icon] of Object.entries(KIND_ICON)) {
    assert.equal(src.includes(icon), false,
      `MessageRow carries a second copy of the ${kind} glyph ${icon}`);
  }
});
