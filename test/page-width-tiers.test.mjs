// Page width tiers (CHI-325 review, contract "Page width tiers").
//
// Seven ad-hoc per-organ max-widths had accreted, each chosen as its surface
// landed. The pin is not the pixel values: it is that a surface picks one of
// three NAMED tiers rather than inventing another number, which is the thing
// that quietly regresses the next time a page is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'),
  'utf8',
);

const READING = ['.briefing-page', '.safety-page'];
const TABLE = ['.modules-page', '.jobs-page', '.records-page', '.reference-page'];

test('the tier tokens are defined once', () => {
  assert.match(css, /--page-read:\s*\d+px;/);
  assert.match(css, /--page-table:\s*\d+px;/);
});

test('every tiered page uses a token, never a raw pixel width', () => {
  for (const [cls, token] of [
    ...READING.map((c) => [c, '--page-read']),
    ...TABLE.map((c) => [c, '--page-table']),
  ]) {
    const rule = new RegExp(`\\${cls} \\{[^}]*max-width:\\s*var\\(${token}\\)`);
    assert.match(css, rule, `${cls} must use var(${token})`);
    const raw = new RegExp(`\\${cls} \\{[^}]*max-width:\\s*\\d+px`);
    assert.ok(!raw.test(css), `${cls} still hardcodes a pixel max-width; pick a tier instead`);
  }
});
