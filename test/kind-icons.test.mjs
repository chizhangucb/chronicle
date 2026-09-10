// The chat-type glyph pins for src/kinds.ts.
//
// KIND_ICON is the single source of truth for the marker in front of every
// message kind (Playback rows, Refine rows, the Refine export). It sat outside
// the app's mono-glyph vocabulary for three kinds — user/thinking/tool_use were
// colored emoji (issue #204) — so these pins hold the vocabulary rule at the
// map itself rather than only at the repo-wide sweep.
//
// COLORED means default emoji presentation (\p{Emoji_Presentation}): a code
// point a renderer draws in color with no variation selector. It is the precise
// reading of the rubric's "zero colored emoji", and the reason the canonical
// mono set (⚙ ✳ ⚠ ↩ ✂ …) passes it: those are Emoji=Yes but text-presentation
// by default, so they render as glyphs in the surrounding type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_ICON, KIND_LABEL } from '../src/kinds.ts';

const COLORED = /\p{Emoji_Presentation}/u;

test('KIND_ICON: every kind carries a monochrome glyph', () => {
  for (const [kind, icon] of Object.entries(KIND_ICON)) {
    assert.ok(icon.length > 0, `${kind} has no icon`);
    assert.equal(COLORED.test(icon), false, `${kind} icon ${icon} is a colored emoji`);
  }
});

test('KIND_ICON: covers exactly the display kinds KIND_LABEL names', () => {
  assert.deepEqual(Object.keys(KIND_ICON).sort(), Object.keys(KIND_LABEL).sort());
});

test('KIND_ICON: one glyph per kind, never shared', () => {
  const icons = Object.values(KIND_ICON);
  assert.equal(new Set(icons).size, icons.length, `duplicate glyph in ${icons.join(' ')}`);
});
