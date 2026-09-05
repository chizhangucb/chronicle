// One page width (CHI-325 review, contract "Page width").
//
// Seven ad-hoc per-organ max-widths came first; a two-tier prose-vs-table split
// came second and still read as inconsistent when navigating, because the thing
// you notice moving between pages is the FRAME jumping width. The pin is not the
// pixel value: it is that a surface uses the shared token rather than inventing
// another number, which is exactly how this regressed twice already.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/read-source.mjs';

// styles.css is ~140KB; a read under 1000 bytes is a mid-write truncation, never
// the real file, so re-read it (CHI-382). The floor sits far below the real size
// and far above any truncation fragment.
const css = readSource(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'),
  { minBytes: 1000 },
);

/** Every non-dashboard surface. Dashboards are full bleed and carry no cap. */
const FRAMED = [
  '.reference-page',
];

test('the page-width token is defined once', () => {
  assert.match(css, /--page-max:\s*\d+px;/);
  // The retired two-tier tokens must not come back alongside it.
  assert.ok(!/--page-read:/.test(css), 'the prose/table tier split was collapsed to one width');
  assert.ok(!/--page-table:/.test(css), 'the prose/table tier split was collapsed to one width');
});

test('every framed page uses the token, never a raw pixel width', () => {
  for (const cls of FRAMED) {
    const usesToken = new RegExp(`\\${cls} \\{[^}]*max-width:\\s*var\\(--page-max\\)`);
    assert.match(css, usesToken, `${cls} must use var(--page-max)`);
    const raw = new RegExp(`\\${cls} \\{[^}]*max-width:\\s*\\d+px`);
    assert.ok(!raw.test(css), `${cls} hardcodes a pixel max-width; use the shared token`);
  }
});

test('prose blocks keep their own measure cap', () => {
  // A wide frame must never mean a 200-character line: readability is solved on
  // the TEXT, which is what lets the frame stay constant.
  assert.match(css, /\.reference-page \.ref-intro \{[^}]*max-width:\s*\d+ch/);
  assert.match(css, /\.settings-block p \{[^}]*max-width:\s*\d+ch/);
});
