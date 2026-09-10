// Keyboard, screen-reader and touch access for the two resize handles
// (issue #201). The drag itself was pointer-only: `role="separator"` with no
// focus, no arrow keys, no aria values and no `touch-action`, so a keyboard or
// screen-reader operator could not resize either pane at all.
//
// Three seams, one per way the handle is now reachable:
//   1. `nextWidthForKey` — the arrow-key geometry, shared with the pointer
//      drag's clamp so the two can never disagree about the bounds.
//   2. `useResizable().handleProps` — what the handle element carries: focus
//      and the live aria value trio.
//   3. src/styles.css + the two call sites — `touch-action: none` and that
//      both handles actually spread the props.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWidthForKey, RESIZE_STEP } from '../src/useResizable.ts';

// The sidebar's real bounds (App.tsx), used as the worked example throughout.
const SIDEBAR = { min: 160, max: 320, edge: 'right' };

test('an arrow key steps the width by one step in the direction the panel grows', () => {
  // edge 'right' = panel sits LEFT of the handle, so right grows it.
  assert.equal(nextWidthForKey('ArrowRight', 200, SIDEBAR), 200 + RESIZE_STEP);
  assert.equal(nextWidthForKey('ArrowLeft', 200, SIDEBAR), 200 - RESIZE_STEP);
});

test('the step direction follows the edge, so a left-edge panel grows leftwards', () => {
  const rail = { min: 160, max: 320, edge: 'left' };
  assert.equal(nextWidthForKey('ArrowLeft', 200, rail), 200 + RESIZE_STEP);
  assert.equal(nextWidthForKey('ArrowRight', 200, rail), 200 - RESIZE_STEP);
});

test('stepping clamps to the same min and max the pointer drag uses', () => {
  assert.equal(nextWidthForKey('ArrowRight', 312, SIDEBAR), 320);
  assert.equal(nextWidthForKey('ArrowLeft', 168, SIDEBAR), 160);
  // Already at a bound: the key is still handled, the width just stays put.
  assert.equal(nextWidthForKey('ArrowRight', 320, SIDEBAR), 320);
  assert.equal(nextWidthForKey('ArrowLeft', 160, SIDEBAR), 160);
});

test('a width outside the bounds is pulled back inside rather than stepped past', () => {
  assert.equal(nextWidthForKey('ArrowRight', 400, SIDEBAR), 320);
  assert.equal(nextWidthForKey('ArrowLeft', 100, SIDEBAR), 160);
});

test('keys that are not a horizontal arrow are left to the browser', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) {
    assert.equal(nextWidthForKey(key, 200, SIDEBAR), null, `${key} must not resize`);
  }
});
