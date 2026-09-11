// The app-wide no-colored-emoji sweep (design rubric, "App-wide invariants").
//
// The rubric's glyph rule is: chrome and page content use the mono glyph
// vocabulary or an SVG, never a colored emoji. It was a grep-by-hand rule with
// one standing carve-out (src/kinds.ts KIND_ICON, issue #204); the carve-out is
// gone, so the rule is a pin.
//
// What counts as colored is defined once, in test/helpers/colored-emoji.mjs.
//
// Scope is the app the operator sees plus the contracts that describe it: src/
// (the client), server/, shared/, bin/ and spec/. Deliberately OUT of scope, and
// the boundary the rubric states: docs/ and website/ are published prose with
// their own voice (the supported-tools matrix uses ✅ as data, not chrome), and
// test/ and scripts/ are not chrome at all — this file has to be able to name an
// offender to report it. Tracked paths only, so dist/ and node_modules/ can
// never make the sweep flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tracked, read, BINARY } from './helpers/tracked-files.mjs';
import { COLORED_EMOJI } from './helpers/colored-emoji.mjs';

const APP_DIRS = ['src/', 'server/', 'shared/', 'bin/'];

/** Every tracked, readable text file under one of `dirs`. */
const filesUnder = (dirs) =>
  tracked.filter((p) => dirs.some((d) => p.startsWith(d)) && !BINARY.test(p));

/** `[path, line-number, line]` for every line carrying a default-color emoji. */
function offenders(paths) {
  const hits = [];
  for (const p of paths) {
    read(p).split('\n').forEach((line, i) => {
      if (COLORED_EMOJI.test(line)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

test('app source carries no colored emoji', () => {
  const paths = filesUnder(APP_DIRS);
  // Named files, not a count: a sweep that silently stopped seeing the client or
  // the server would otherwise pass by finding nothing.
  for (const anchor of ['src/kinds.ts', 'src/session/MessageRow.tsx', 'server/api.ts', 'shared/types.ts']) {
    assert.ok(paths.includes(anchor), `sweep no longer reaches ${anchor} — scope is wrong`);
  }
  assert.deepEqual(offenders(paths), []);
});

test('the spec contracts carry no colored emoji, so no carve-out can name one', () => {
  const paths = tracked.filter((p) => p.startsWith('spec/') && p.endsWith('.md'));
  assert.ok(paths.length > 0, 'no spec contracts found — scope is wrong');
  assert.deepEqual(offenders(paths), []);
});

// The emoji sweep above cannot see a carve-out written WITHOUT the emoji, and a
// rule with a standing exception is not a rule. This is the exact marker the
// rubric used to grant one; split on the top-level bullets so each contract
// clause is judged on its own, not as one run-on list.
const GRANTS_A_GAP = /known[\s\S]{0,20}?gap/i;

test('the spec contracts carve out no known gap for KIND_ICON', () => {
  for (const p of tracked.filter((f) => f.startsWith('spec/') && f.endsWith('.md'))) {
    for (const clause of read(p).split(/\n(?=\s*- )/)) {
      if (!/KIND_ICON/.test(clause)) continue;
      assert.equal(GRANTS_A_GAP.test(clause), false,
        `${p} still carves KIND_ICON out of the glyph rule:\n${clause.trim()}`);
    }
  }
});
