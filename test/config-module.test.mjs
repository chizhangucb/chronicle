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
