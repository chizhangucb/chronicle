// Removal pin for #295: Chronicle is English only.
//
// The dictionary lookup (`src/i18n.ts`), the zh and ja dictionaries and the
// topbar language dropdown are gone, and every former `t()` call site holds its
// English string directly. What survives is the `Intl` formatting: the date,
// hour and weekday labels still format on `en-US`, not on the browser's
// default, so the surfaces read the same as they did with the language set to
// English.
//
// Asserted off disk over `git ls-files`, like the page-width, reference-registry
// and transcript-delete-removed pins: a translation wrapper, a dictionary entry
// and a dropdown label are text an operator meets, not exported symbols, so a
// module import would not see them. The tracked list comes from the ONE reader
// in test/helpers/tracked-files.mjs, so this sweep cannot drift from the
// repo-shape and local-first sweeps. Gitignored artifacts (dist/, node_modules/)
// can never make this flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, git, tracked } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';

/** Every git-tracked client module. The dictionary and the menu both lived here. */
const CLIENT_SOURCES = git('ls-files', '--', 'src').split('\n').filter(Boolean)
  .filter((rel) => /\.tsx?$/.test(rel));
// `readSource`, not the helper's plain `read`: this pin sweeps src/ while an
// agent may be editing it, and a read that lands in a truncate+write window
// would otherwise pass vacuously on an empty file.
const read = (rel) => readSource(path.join(REPO, rel));

// This file is the pin, so it has to spell the words it forbids; CHANGELOG.md is
// history and is allowed to name what was. Same exemption shape as the
// vocabulary sweep in test/repo-shape.test.mjs.
const PIN_EXEMPT = new Set(['test/languages-removed.test.mjs', 'CHANGELOG.md']);

test('the i18n module is not tracked and nothing imports it', () => {
  assert.ok(CLIENT_SOURCES.length > 20, `expected the client source set to be populated, got ${CLIENT_SOURCES.length}`);
  assert.equal(tracked.includes('src/i18n.ts'), false, 'src/i18n.ts is tracked again');
  const importers = CLIENT_SOURCES.filter((rel) => /from\s+'[^']*i18n(?:\.[jt]s)?'/.test(read(rel)));
  assert.deepEqual(importers, [], `these modules still import the i18n module: ${importers.join(', ')}`);
});

test('no client module calls the t() translation wrapper', () => {
  // `t(` only, never `.at(`, `format(`, `Boolean t(`-in-a-string and friends:
  // the lookbehind rejects an identifier, member or string character in front.
  const WRAPPER = /(?<![\w$.'"`])t\(/;
  const offenders = CLIENT_SOURCES.filter((rel) => WRAPPER.test(read(rel)));
  assert.deepEqual(offenders, [], `the t() wrapper survives in: ${offenders.join(', ')}`);
});

test('no tracked file carries a zh or ja dictionary string', () => {
  // Han, Hiragana and Katakana. The app dictionaries and the website
  // walkthrough's per-locale captions were the only tracked sources of CJK text
  // in the repo; a hit means a dictionary, a menu label or a localized caption
  // grew back. `.vue` is in the extension list so the website component the
  // captions lived in is covered too, not just the app source.
  const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
  const offenders = tracked.filter((rel) => {
    // Lockfiles everywhere, not just the root one: `website/` ships its own.
    if (PIN_EXEMPT.has(rel) || rel.endsWith('package-lock.json')) return false;
    if (!/\.(tsx?|jsx?|mjs|vue|css|md|html|json|yml|yaml)$/.test(rel)) return false;
    return CJK.test(read(rel));
  });
  assert.deepEqual(offenders, [], `translated strings survive in: ${offenders.join(', ')}`);
});

test('no language menu, language state or language setter survives', () => {
  const MENU = [
    { what: 'the persisted language key', re: /chronicle-lang/ },
    { what: 'the language setter', re: /\bsetLang\b/ },
    { what: 'the language dropdown', re: /\blang-select\b|\bLANGS\b/ },
    { what: 'the Lang type', re: /\bLang\b(?!uage)/ },
    { what: 'the language-to-locale map', re: /\bINTL_LOCALE\b/ },
  ];
  for (const { what, re } of MENU) {
    const offenders = tracked
      .filter((rel) => !PIN_EXEMPT.has(rel) && /\.(tsx?|jsx?|mjs|vue|css|md)$/.test(rel))
      .filter((rel) => re.test(read(rel)));
    assert.deepEqual(offenders, [], `${what} is back in: ${offenders.join(', ')}`);
  }
});

test('every locale the language map used to feed still resolves to en-US', () => {
  // These are the call sites the deleted `INTL_LOCALE` map fed: the month, day,
  // weekday and hour labels on Insights, Sessions, Explore and Spend. Losing
  // the locale here (`Intl.DateTimeFormat(undefined)`, a dropped second
  // argument) would re-point them at the browser's locale, which is the one
  // regression this removal could cause and is invisible on a US machine.
  //
  // The call sites elsewhere that deliberately format in the BROWSER's locale
  // (`toLocaleString()`, `toLocaleDateString(undefined, …)` in Timeline,
  // RecentLedger, CodePanel and friends) are none of this pin's business: they
  // read that way on `main` too, whatever the language was set to.
  const LOCALE_ARG = [
    /new Intl\.DateTimeFormat\(\s*([^,)]+)/g,
    /\bfmtDayLabel\(\s*[^,]+,\s*([^)]+)\)/g,
    /\bfmtHourLabel\(\s*[^,]+,\s*([^)]+)\)/g,
    /\bfmtHourOfDay\(\s*[^,]+,\s*([^)]+)\)/g,
  ];
  /** The argument as written, or what a same-file `const` binds it to, so
   *  hoisting the literal into one named constant still reads as en-US. */
  const resolve = (arg, src) => {
    const written = arg.trim();
    if (/^['"]/.test(written)) return written.slice(1, -1);
    const bound = src.match(new RegExp(`\\bconst ${written}\\s*(?::[^=]+)?=\\s*'([^']*)'`));
    return bound ? bound[1] : written;
  };
  const bad = [];
  let seen = 0;
  for (const rel of CLIENT_SOURCES) {
    if (rel === 'src/charts/timeBuckets.ts') continue; // takes `locale` as its parameter
    const src = read(rel);
    for (const re of LOCALE_ARG) {
      for (const m of src.matchAll(re)) {
        seen++;
        if (resolve(m[1], src) !== 'en-US') bad.push(`${rel}: ${m[0].trim()}`);
      }
    }
  }
  assert.ok(seen >= 5, `expected the locale call sites to be found, got ${seen}`);
  assert.deepEqual(bad, [], `these call sites no longer format on en-US: ${bad.join(' | ')}`);
});

test('the surface contract lists no language dropdown among the every-route controls', () => {
  const contract = read('spec/surface-contract.md');
  assert.doesNotMatch(contract, /language dropdown/i, 'the frozen surface still promises a language dropdown');
});

test('the README no longer advertises multiple UI languages', () => {
  assert.doesNotMatch(read('README.md'), /\bi18n\b/i, 'the README still advertises i18n');
});
