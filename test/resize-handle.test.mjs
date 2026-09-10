// Keyboard, screen-reader and touch access for the two resize handles
// (issue #201). The drag itself was pointer-only: `role="separator"` with no
// focus, no arrow keys, no aria values and no `touch-action`, so a keyboard or
// screen-reader operator could not resize either pane at all.
//
// Three seams, one per way the handle is now reachable:
//   1. `nextWidthForKey`, the arrow-key geometry, shared with the pointer
//      drag's clamp so the two can never disagree about the bounds.
//   2. `useResizable().handleProps`, what the handle element carries: focus
//      and the live aria value trio.
//   3. src/styles.css and the two call sites: `touch-action: none`, a hit area
//      a fingertip can land on, and the wiring reaching both handles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/read-source.mjs';
import { nextWidthForKey, useResizable } from '../src/useResizable.ts';

// The sidebar's real bounds (App.tsx), used as the worked example throughout.
const SIDEBAR = { min: 160, max: 320, edge: 'right' };

// One press moves the handle 16px, the step the hook keeps to itself.
test('an arrow key steps the width by one step in the direction the panel grows', () => {
  // edge 'right' = panel sits LEFT of the handle, so right grows it.
  assert.equal(nextWidthForKey('ArrowRight', 200, SIDEBAR), 216);
  assert.equal(nextWidthForKey('ArrowLeft', 200, SIDEBAR), 184);
});

test('the step direction follows the edge, so a left-edge panel grows leftwards', () => {
  const rail = { min: 160, max: 320, edge: 'left' };
  assert.equal(nextWidthForKey('ArrowLeft', 200, rail), 216);
  assert.equal(nextWidthForKey('ArrowRight', 200, rail), 184);
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

// --- Seam 2: what the handle element itself carries -------------------------
//
// `handleProps` is rendered through React's server renderer rather than
// asserted as a literal object: it is the same call path App.tsx and
// SessionView.tsx take, and it is the only way to see the hook's real starting
// width (read from storage) reach `aria-valuenow`.

/** Minimal stand-in for the browser APIs the hook touches. */
function fakeWindow(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    read: (k) => (store.has(k) ? store.get(k) : null),
  };
}

/** Run `fn` with the fake window (and the body class the drag toggles) in place. */
function withWindow(win, fn) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = { body: { classList: { add: () => {}, remove: () => {} } } };
  try {
    return fn();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

/** Mount `useResizable` once and hand back what it returned. */
async function mount(options, win) {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  let captured;
  function Probe() { captured = useResizable(options); return null; }
  withWindow(win, () => renderToStaticMarkup(createElement(Probe)));
  return captured;
}

/** A key press on the focused handle. Returns whether the handle consumed it. */
function press(handleProps, key, win, modifiers = {}) {
  let prevented = false;
  withWindow(win, () => handleProps.onKeyDown({
    key, ...modifiers, preventDefault: () => { prevented = true; },
  }));
  return prevented;
}

/** A pointer grabbing the handle, reporting what the handle element was asked to do. */
function grab(handleProps, win) {
  const asked = { focused: false };
  const handle = {
    focus: () => { asked.focused = true; },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
  withWindow(win, () => handleProps.onPointerDown({
    clientX: 0, pointerId: 1, currentTarget: handle,
    preventDefault: () => {}, stopPropagation: () => {},
  }));
  return asked;
}

const SIDEBAR_OPTIONS = {
  storageKey: 'chronicle.sidebarW', fallback: 192, min: 160, max: 320, edge: 'right',
};

test('the handle is focusable and announces itself as a vertical separator', async () => {
  const { handleProps } = await mount(SIDEBAR_OPTIONS, fakeWindow());
  assert.equal(handleProps.tabIndex, 0);
  assert.equal(handleProps.role, 'separator');
  assert.equal(handleProps['aria-orientation'], 'vertical');
});

test('the handle exposes its bounds and its current width as aria values', async () => {
  const win = fakeWindow({ 'chronicle.sidebarW': '240' });
  const { handleProps } = await mount(SIDEBAR_OPTIONS, win);
  assert.equal(handleProps['aria-valuemin'], 160);
  assert.equal(handleProps['aria-valuemax'], 320);
  // Not the fallback: the value tracks the width the pane actually has.
  assert.equal(handleProps['aria-valuenow'], 240);
});

test('arrow keys resize the pane and the announced value follows', async () => {
  const win = fakeWindow({ 'chronicle.sidebarW': '240' });
  const first = await mount(SIDEBAR_OPTIONS, win);
  assert.equal(press(first.handleProps, 'ArrowRight', win), true, 'a handled key is consumed');
  assert.equal(win.read('chronicle.sidebarW'), '256');
  press(first.handleProps, 'ArrowRight', win);
  assert.equal(win.read('chronicle.sidebarW'), '272', 'presses accumulate off the live width');

  // The next reader of the pane sees the new width, aria value included.
  const second = await mount(SIDEBAR_OPTIONS, win);
  assert.equal(second.width, 272);
  assert.equal(second.handleProps['aria-valuenow'], 272);
});

test('arrow keys stop at the same bounds the pointer drag clamps to', async () => {
  const win = fakeWindow({ 'chronicle.sidebarW': '312' });
  const { handleProps } = await mount(SIDEBAR_OPTIONS, win);
  press(handleProps, 'ArrowRight', win);
  press(handleProps, 'ArrowRight', win);
  assert.equal(win.read('chronicle.sidebarW'), '320', 'never past max');

  const low = fakeWindow({ 'chronicle.sidebarW': '168' });
  const atFloor = await mount(SIDEBAR_OPTIONS, low);
  press(atFloor.handleProps, 'ArrowLeft', low);
  press(atFloor.handleProps, 'ArrowLeft', low);
  assert.equal(low.read('chronicle.sidebarW'), '160', 'never past min');
});

test('keys the handle does not answer are left to the browser', async () => {
  const win = fakeWindow({ 'chronicle.sidebarW': '240' });
  const { handleProps } = await mount(SIDEBAR_OPTIONS, win);
  assert.equal(press(handleProps, 'Tab', win), false, 'Tab must still move focus');
  assert.equal(win.read('chronicle.sidebarW'), '240', 'and must not resize');
});

test('a modified arrow stays with the browser, so history navigation still works', async () => {
  const win = fakeWindow({ 'chronicle.sidebarW': '240' });
  const { handleProps } = await mount(SIDEBAR_OPTIONS, win);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
    assert.equal(press(handleProps, 'ArrowLeft', win, { [modifier]: true }), false,
      `${modifier}+ArrowLeft is the browser's, not the handle's`);
  }
  assert.equal(win.read('chronicle.sidebarW'), '240', 'and none of them resized the pane');
});

test('grabbing the handle with a pointer focuses it, so arrow keys can finish the drag', async () => {
  // The drag's own preventDefault() suppresses the browser's focus-on-mousedown,
  // which would otherwise leave a just-dragged handle unfocused.
  const win = fakeWindow();
  const { handleProps } = await mount(SIDEBAR_OPTIONS, win);
  assert.equal(grab(handleProps, win).focused, true);
});

// --- Seam 3: the handles on the page ----------------------------------------
//
// Read off disk (the same reason page-width.test.mjs does): a `touch-action`
// declaration and a JSX spread are invisible to a module import, and both are
// exactly the kind of thing a later edit drops without noticing.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readSource(path.join(SRC, 'styles.css'), { minBytes: 1000 });

/** Every element a `useResizable` handle renders as. */
const HANDLES = ['.drag-handle', '.pane-handle'];

test('a handle opts out of touch panning so a touch drag resizes instead of scrolling', () => {
  for (const cls of HANDLES) {
    const rule = new RegExp(`\\${cls} \\{[^}]*touch-action:\\s*none`);
    assert.match(css, rule, `${cls} must set touch-action: none or a touch drag never starts`);
  }
});

test('the thin sidebar handle still offers a finger-sized hit area', () => {
  // 4px is a mouse target. A touch drag needs the house-rule 24px, widened
  // with an overlay so the visible line stays thin.
  assert.match(css, /\.drag-handle::before \{[^}]*position:\s*absolute/);
  const overlay = css.match(/\.drag-handle::before \{([^}]*)\}/)[1];
  const left = Number(overlay.match(/left:\s*(-?\d+)px/)[1]);
  const right = Number(overlay.match(/right:\s*(-?\d+)px/)[1]);
  const handleWidth = 4; // .drag-handle's visible line, above
  assert.ok(handleWidth - left - right >= 24,
    `sidebar handle hit area is ${handleWidth - left - right}px, below the 24px target minimum`);
});

test('a focused handle is visibly focused', () => {
  // Focusable with no focus ring is a keyboard trap in all but name.
  assert.match(css, /\.drag-handle:focus-visible[^{]*\{[^}]*outline/);
});

test('both handles carry the keyboard and screen-reader wiring, not just the sidebar one', () => {
  // The regression this guards is one handle getting the treatment and the
  // other staying pointer-only, which is the state #201 found the app in.
  for (const [file, cls] of [['App.tsx', 'drag-handle'], ['SessionView.tsx', 'pane-handle']]) {
    const src = readSource(path.join(SRC, file));
    const tag = src.match(new RegExp(`<div className="${cls}"[^>]*/>`, 's'));
    assert.ok(tag, `${file} must still render the ${cls} element`);
    // Either spread from the hook (what both do today) or set by hand: what
    // matters is that the element ends up focusable, keyed and value-labelled.
    const wired = /\{\.\.\.\w+\.handleProps\}/.test(tag[0])
      || (/tabIndex/.test(tag[0]) && /onKeyDown/.test(tag[0]) && /aria-valuenow/.test(tag[0]));
    assert.ok(wired, `${file}'s ${cls} is pointer-only again: no keyboard or aria wiring`);
  }
});
