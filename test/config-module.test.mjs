// The one config module (server/config.ts), issue #303.
//
// Chronicle's data folder and its config.json had six readers: dataDir.ts held
// `resolveDataDir` while noiseGate.ts, autosync.ts, ask.ts, run-ask.ts,
// ask-db-mcp.ts and routes/_shared.ts each inlined `CHRONICLE_DATA_DIR ||
// ~/.chronicle`, and the noise gate kept a private config reader to dodge a
// db.ts <-> autosync.ts import cycle. One module owns both now.
//
// The behaviour is meant to be unchanged, so the assertions are the folder the
// env override picks, the fallback under the home directory, and the values a
// written config reads back as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, git, tracked } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';

// Set BEFORE the import: the module freezes the folder at import time, the same
// way server/db.ts binds its database handle (see test/helpers.mjs).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-config-'));
process.env.CHRONICLE_DATA_DIR = dir;
const config = await import('../server/config.ts');

test('the data folder is $CHRONICLE_DATA_DIR when it is set', () => {
  assert.equal(config.resolveDataDir({ CHRONICLE_DATA_DIR: '/tmp/elsewhere' }), '/tmp/elsewhere');
});

test('the data folder falls back to ~/.chronicle', () => {
  assert.equal(config.resolveDataDir({}), path.join(os.homedir(), '.chronicle'));
  // Blank and whitespace-only read as unset, not as a path of their own.
  assert.equal(config.resolveDataDir({ CHRONICLE_DATA_DIR: '' }), path.join(os.homedir(), '.chronicle'));
  assert.equal(config.resolveDataDir({ CHRONICLE_DATA_DIR: '   ' }), path.join(os.homedir(), '.chronicle'));
});

test('the module exposes the folder this process is bound to', () => {
  assert.equal(config.dataDir, dir);
});

test('a written config reads back from config.json in the data folder', () => {
  const written = config.writeConfig({ autoSync: false, monthlyBudget: 42 });
  assert.equal(written.autoSync, false);
  assert.equal(written.monthlyBudget, 42);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.autoSync, false);
  assert.equal(onDisk.monthlyBudget, 42);
  assert.deepEqual(config.readConfig(), onDisk);
});

test('a write patches the config rather than replacing it', () => {
  config.writeConfig({ ask: true });
  const after = config.readConfig();
  assert.equal(after.ask, true);
  assert.equal(after.autoSync, false, 'the earlier key survived the patch');
});

test('the noise gate reads its thresholds from the same config', async () => {
  // The gate used to parse config.json itself, to dodge the db.ts <-> autosync.ts
  // import cycle. It now goes through the one module, so a threshold written
  // here is the threshold the gate applies.
  const { isMinorSession, DEFAULT_MINOR_ACTIVE_MS } = await import('../server/noiseGate.ts');
  const twentyMinutes = 20 * 60 * 1000;
  assert.equal(isMinorSession(DEFAULT_MINOR_ACTIVE_MS + 1, 3), false, 'above the default active threshold');

  config.writeConfig({ minorActiveMsThreshold: twentyMinutes, minorMessageCountThreshold: 5 });
  assert.equal(isMinorSession(DEFAULT_MINOR_ACTIVE_MS + 1, 3), true, 'the written threshold now applies');
  assert.equal(isMinorSession(twentyMinutes, 3), false, 'still strict less-than');
  assert.equal(isMinorSession(60 * 1000, 5), false, 'the written message count applies too');
});

test('an absent or unparseable config reads as empty', () => {
  // Last in the file on purpose: it takes the config.json the tests above wrote
  // away again. An empty read is what makes every caller's `?? default` decide.
  fs.rmSync(path.join(dir, 'config.json'));
  assert.deepEqual(config.readConfig(), {});
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.deepEqual(config.readConfig(), {});
});

// ---- the one module, swept off disk ------------------------------------
// Read over `git ls-files` like the repo-shape, languages-removed and
// local-first pins: an inlined fallback is text in a source file, and a module
// import would not see the copy that is about to grow back.
const SOURCES = git('ls-files', '--', 'server', 'scripts', 'shared', 'src', 'bin')
  .split('\n').filter(Boolean)
  .filter((rel) => /\.(?:m?js|tsx?)$/.test(rel));
const read = (rel) => readSource(path.join(REPO, rel));

// This file is the pin, so it has to spell the pattern it forbids.
const OWNER = 'server/config.ts';
const PIN = 'test/config-module.test.mjs';

test('no module outside the config module inlines the data-folder fallback', () => {
  assert.ok(SOURCES.length > 50, `expected a populated source set, got ${SOURCES.length}`);
  // `CHRONICLE_DATA_DIR ||` / `?? ` — the fallback, not the assignments the CLI
  // and the test harness make (`process.env.CHRONICLE_DATA_DIR = dir`).
  const FALLBACK = /CHRONICLE_DATA_DIR[^\n]*(?:\|\||\?\?)/;
  const offenders = SOURCES.filter((rel) => rel !== OWNER && FALLBACK.test(read(rel)));
  assert.deepEqual(offenders, [], `these modules inline the data-folder fallback: ${offenders.join(', ')}`);
});

test('no module outside the config module builds a path to config.json', () => {
  const CONFIG_PATH = /(?:path\.)?join\([^)]*['"]config\.json['"]\)/;
  const offenders = SOURCES.filter((rel) => rel !== OWNER && CONFIG_PATH.test(read(rel)));
  assert.deepEqual(offenders, [], `these modules build their own config path: ${offenders.join(', ')}`);
});

test('no module outside the config module defines a config reader or writer', () => {
  const DEFINES = /(?:function|const)\s+(?:read|write)[A-Za-z]*Config\b/;
  const offenders = SOURCES.filter((rel) => rel !== OWNER && DEFINES.test(read(rel)));
  assert.deepEqual(offenders, [], `these modules define their own config reader: ${offenders.join(', ')}`);
});

test('the pre-consolidation data-folder module is gone', () => {
  assert.equal(tracked.includes('server/dataDir.ts'), false, 'server/dataDir.ts is tracked again');
  const importers = SOURCES.filter((rel) => /from\s+'[^']*dataDir(?:\.[jt]s)?'/.test(read(rel)));
  assert.deepEqual(importers, [], `these modules still import the old data-folder module: ${importers.join(', ')}`);
});

test('every reader of the folder or the config imports the one module', () => {
  // The six the audit's F6 listed, minus the installer script #296 deleted, plus
  // db.ts which already went through the old module.
  const READERS = [
    'server/db.ts', 'server/noiseGate.ts', 'server/autosync.ts', 'server/ask.ts',
    'scripts/run-ask.ts', 'scripts/ask-db-mcp.ts',
  ];
  const IMPORTS_OWNER = /from\s+'[^']*\/config\.ts'/;
  const missing = READERS.filter((rel) => {
    assert.ok(tracked.includes(rel), `${rel} is not tracked`);
    return !IMPORTS_OWNER.test(read(rel));
  });
  assert.deepEqual(missing, [], `these readers do not import ${OWNER}: ${missing.join(', ')}`);
});

test('the pin itself is the only file allowed to spell these patterns', () => {
  assert.equal(SOURCES.includes(PIN), false, 'the pin moved into the swept set');
});
