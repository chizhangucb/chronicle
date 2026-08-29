// Anti-drift pins for the definitions registry (CHI-325 3b, decision D3).
//
// The reference page's entire value is that it CANNOT diverge from what the
// surfaces say. That only holds while both read the same registry, so these
// tests guard the two ways it could quietly stop holding:
//
//   1. An InfoTip pointing at a definition id that does not exist (the tip
//      would render blank).
//   2. An InfoTip going back to an inline `text=` string, which recreates the
//      second source of truth the registry was built to remove.
//
// (2) is why the allowlist below is explicit rather than a count: the escape
// hatch is legitimate for tooltips whose content is runtime DATA, and it must
// stay exactly that narrow. Adding a file here should require justifying it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/read-source.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The ONLY legitimate `text=` sites: tooltips whose body is runtime data, not a
// definition, so they can never be a registry entry.
//   HomeDashboard  the proxy-lane tile quotes the actual per-model spend split
//   ContentTab     each characteristic's wording is SERVER-supplied
//                  (server/content.ts Characteristic.info), which is already a
//                  single source; copying it here would create the second one.
const TEXT_PROP_ALLOWLIST = new Set([
  'HomeDashboard.tsx',
  'ContentTab.tsx',
]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const { DEFINITIONS, DEF_BY_ID, DEF_PAGE_ORDER } = await import('../src/reference/definitions.ts');

test('every InfoTip def= id resolves in the registry', () => {
  const missing = [];
  for (const file of files) {
    const src = readSource(file);
    for (const m of src.matchAll(/<InfoTip\s+def="([^"]+)"/g)) {
      if (!DEF_BY_ID.has(m[1])) missing.push(`${path.basename(file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'InfoTip def ids with no registry entry render a blank bubble');
});

test('InfoTip text= survives ONLY at the runtime-data call sites', () => {
  const offenders = [];
  for (const file of files) {
    const src = readSource(file);
    if (!/<InfoTip\s+text=/.test(src)) continue;
    const base = path.basename(file);
    if (!TEXT_PROP_ALLOWLIST.has(base)) offenders.push(base);
  }
  assert.deepEqual(
    offenders, [],
    'a definition belongs in src/reference/definitions.ts, not inline: an inline string is invisible to /reference and drifts',
  );
});

test('at least one InfoTip actually uses the registry', () => {
  // Guards the inverse failure of the test above: an allowlist that passes
  // because every tip quietly reverted to text=.
  let count = 0;
  for (const file of files) {
    count += [...readSource(file).matchAll(/<InfoTip\s+def="/g)].length;
  }
  assert.ok(count >= 30, `expected the registry to back most tips, found ${count}`);
});

test('registry ids are unique and pages are known', () => {
  const seen = new Set();
  for (const d of DEFINITIONS) {
    assert.ok(!seen.has(d.id), `duplicate definition id: ${d.id}`);
    seen.add(d.id);
    assert.ok(DEF_PAGE_ORDER.includes(d.page), `${d.id} sits on unknown page ${d.page}`);
  }
});

test('every definition reads correctly with NO vars', () => {
  // /reference has no call site, so it renders each definition with an empty
  // context. A definition that only makes sense with an interpolated value
  // would read as a broken sentence there.
  for (const d of DEFINITIONS) {
    const plain = d.plain({});
    assert.equal(typeof plain, 'string');
    assert.ok(plain.length > 20, `${d.id}: plain text is too short to be a definition`);
    assert.ok(!plain.includes('undefined'), `${d.id}: renders "undefined" without vars`);
    for (const fn of [d.good, d.tech]) {
      if (!fn) continue;
      const v = fn({});
      assert.ok(typeof v === 'string' && !v.includes('undefined'), `${d.id}: good/tech renders "undefined" without vars`);
    }
  }
});

test('a definition that takes vars still uses them', () => {
  // The two interpolating definitions must actually change when given a value,
  // or the vars plumbing is dead code that will rot.
  const humanAll = DEF_BY_ID.get('sessions.human-all');
  assert.ok(humanAll);
  assert.notEqual(humanAll.plain({}), humanAll.plain({ vars: { automationCount: 42 } }));
  assert.ok(humanAll.plain({ vars: { automationCount: 42 } }).includes('42'));

  const freshness = DEF_BY_ID.get('memory.freshness');
  assert.ok(freshness);
  assert.ok(freshness.plain({}).includes('30'), 'falls back to the default threshold');
  assert.ok(freshness.plain({ vars: { thresholdDays: 14 } }).includes('14'));
});

test('the retired group keeps the vocabulary of dropped surfaces', () => {
  // CHI-322's binding rule: nothing valuable is silently dropped. The surfaces
  // are gone; the terms must still be findable.
  const retired = DEFINITIONS.filter((d) => d.page === 'retired').map((d) => d.id);
  for (const id of ['retired.pinned-panels', 'retired.peek-drill', 'retired.burn-tile']) {
    assert.ok(retired.includes(id), `${id} missing: a dropped surface lost its vocabulary`);
  }
});

test('no em dashes in definition copy', () => {
  // Repo-wide style rule; the registry is the largest block of prose in src/.
  for (const d of DEFINITIONS) {
    const all = `${d.title} ${d.plain({})} ${d.good?.({}) ?? ''} ${d.tech?.({}) ?? ''}`;
    assert.ok(!all.includes('—'), `${d.id} contains an em dash`);
  }
});
