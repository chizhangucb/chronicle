// The client's localStorage keys and the one-time migration off the old names
// (issue #202).
//
// Every key Chronicle owns is `chronicle.<name>`; the two that predate that
// convention (`chronicle-sidebar`, `chronicle-playback-split`) are read once on
// first load, copied to their dot name and deleted, so an operator upgrading
// keeps their collapsed sidebar and their dragged playback split.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, git, tracked } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS, migrateLegacyStorageKeys } from '../src/storage.ts';

// A minimal localStorage: enough of the Web Storage surface for the module.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get size() { return map.size; },
  };
}

const realWindow = globalThis.window;
const realStorage = globalThis.localStorage;

function install(seed) {
  const storage = fakeStorage(seed);
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };
  return storage;
}

beforeEach(() => { install({}); });
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.localStorage = realStorage;
});

test('a collapsed sidebar stored under the old hyphen key survives the migration', () => {
  const storage = install({ 'chronicle-sidebar': 'collapsed' });
  migrateLegacyStorageKeys();
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarCollapsed), 'collapsed');
  assert.equal(storage.getItem('chronicle-sidebar'), null, 'the old key is left behind');
});

test('a value already under the dot key wins over a stale old key', () => {
  const storage = install({ 'chronicle-sidebar': 'collapsed', [STORAGE_KEYS.sidebarCollapsed]: 'expanded' });
  migrateLegacyStorageKeys();
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarCollapsed), 'expanded');
  assert.equal(storage.getItem('chronicle-sidebar'), null);
});

test('a dragged playback split stored under the old hyphen key survives too', () => {
  const storage = install({ 'chronicle-playback-split': '540' });
  migrateLegacyStorageKeys();
  assert.equal(storage.getItem(STORAGE_KEYS.playbackSplit), '540');
  assert.equal(storage.getItem('chronicle-playback-split'), null);
});

test('a second load migrates nothing and leaves the dot keys alone', () => {
  const storage = install({ 'chronicle-sidebar': 'collapsed' });
  migrateLegacyStorageKeys();
  storage.setItem(STORAGE_KEYS.sidebarCollapsed, 'expanded'); // the operator re-expands
  migrateLegacyStorageKeys();
  assert.equal(storage.getItem(STORAGE_KEYS.sidebarCollapsed), 'expanded');
  assert.equal(storage.size, 1, 'only the dot key is left in storage');
});

test('migration survives storage that throws (private mode)', () => {
  const throwing = {
    getItem() { throw new Error('access denied'); },
    setItem() { throw new Error('access denied'); },
    removeItem() { throw new Error('access denied'); },
  };
  globalThis.localStorage = throwing;
  globalThis.window = { localStorage: throwing };
  assert.doesNotThrow(() => migrateLegacyStorageKeys());
});

// The convention itself, swept off disk over the tracked files: a key literal
// is a string an operator's browser holds, not an exported symbol, so only a
// read of the sources can see one drift back to a hyphen (same shape as the
// page-width and languages-removed pins).
const read = (rel) => readSource(path.join(REPO, rel));
/** Every tracked client module — a key can be named here without the word `localStorage`
 *  in sight (a `useResizable({ storageKey })` caller is exactly that shape). */
const CLIENT_SOURCES = git('ls-files', '--', 'src').split('\n').filter(Boolean)
  .filter((rel) => /\.tsx?$/.test(rel));
/** …plus every other tracked code file that touches storage itself (the e2e specs, website/). */
const STORAGE_CALLERS = [...new Set([
  ...CLIENT_SOURCES,
  ...tracked.filter((rel) => /\.(tsx?|mjs|js|html)$/.test(rel) && read(rel).includes('localStorage')),
])].sort();
/** A `chronicle` key literal in any spelling: the dot one and the ones it replaced. */
const KEY_LITERAL = /['"`](chronicle[-._][A-Za-z][\w.-]*)['"`]/g;
/** A key passed straight to storage, or to `useResizable`, whatever it is named. */
const KEY_IN_USE = /(?:(?:get|set|remove)Item\(\s*|storageKey:\s*)['"`]([^'"`]+)['"`]/g;
/**
 * The pre-convention names, and the files allowed to still spell one: the
 * module that migrates the app's (src/storage.ts, the one definition of the
 * list), the marketing page that migrates its own (website/index.html, a
 * separate origin and a separate deploy, so it carries its migration inline),
 * and this pin.
 */
const LEGACY_NAMES = new Set([
  ...LEGACY_STORAGE_KEYS.map(([oldKey]) => oldKey),
  'chronicle_theme', // website/index.html's, migrated inline there
]);
const MIGRATION_OWNERS = new Set(['src/storage.ts', 'website/index.html', 'test/storage-keys.test.mjs']);

test('every chronicle storage key in a tracked source uses the dot convention', () => {
  assert.ok(CLIENT_SOURCES.length > 20, `expected the client source set to be populated, got ${CLIENT_SOURCES.length}`);
  assert.ok(STORAGE_CALLERS.includes('website/index.html'), 'the sweep must reach the marketing page');
  const offenders = [];
  for (const rel of STORAGE_CALLERS) {
    for (const [, key] of read(rel).matchAll(KEY_LITERAL)) {
      if (key.startsWith('chronicle.')) continue;
      // A legacy name is fine where the migration off it lives, nowhere else.
      if (LEGACY_NAMES.has(key) && MIGRATION_OWNERS.has(rel)) continue;
      offenders.push(`${rel}: ${key}`);
    }
  }
  assert.deepEqual(offenders, [], `these keys are not \`chronicle.<name>\`: ${offenders.join(', ')}`);
});

test('every key handed to storage is namespaced, whatever it is called', () => {
  const offenders = [];
  for (const rel of STORAGE_CALLERS) {
    if (rel === 'test/storage-keys.test.mjs') continue; // its fake storage takes any key
    for (const [, key] of read(rel).matchAll(KEY_IN_USE)) {
      if (key.startsWith('chronicle.')) continue;
      if (LEGACY_NAMES.has(key) && MIGRATION_OWNERS.has(rel)) continue;
      offenders.push(`${rel}: ${key}`);
    }
  }
  assert.deepEqual(offenders, [], `these keys are not namespaced: ${offenders.join(', ')}`);
});

test('no source writes a pre-convention key', () => {
  const offenders = [];
  for (const rel of STORAGE_CALLERS) {
    if (rel === 'test/storage-keys.test.mjs') continue; // seeds the old key on purpose
    for (const [, key] of read(rel).matchAll(/setItem\(\s*['"`]([^'"`]+)['"`]/g)) {
      if (LEGACY_NAMES.has(key)) offenders.push(`${rel}: ${key}`);
    }
  }
  assert.deepEqual(offenders, [], `these sources write an old key: ${offenders.join(', ')}`);
});

test('the key registry holds only dot keys, and one per name', () => {
  const values = Object.values(STORAGE_KEYS);
  for (const key of values) assert.match(key, /^chronicle\.[a-z][A-Za-z]*$/, `${key} is not chronicle.<name>`);
  assert.equal(new Set(values).size, values.length, 'two names share a key');
});

test('every key the migration moves to is one the registry owns', () => {
  const owned = new Set(Object.values(STORAGE_KEYS));
  for (const [oldKey, newKey] of LEGACY_STORAGE_KEYS) {
    assert.ok(owned.has(newKey), `${oldKey} migrates to ${newKey}, which no name in the registry owns`);
  }
});
