// Pins for nisse-hub resolution + detection + mode (server/hub/resolve.ts).
// resolveHub reads config.json from CHRONICLE_DATA_DIR/config.json (via
// autosync.readConfig), so point CHRONICLE_DATA_DIR at a temp dir BEFORE import
// and manage config.json per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-resolve-data-'));
process.env.CHRONICLE_DATA_DIR = data;
const CONFIG = path.join(data, 'config.json');
const setConfig = (obj) => fs.writeFileSync(CONFIG, JSON.stringify(obj));
const clearConfig = () => { try { fs.unlinkSync(CONFIG); } catch {} };

function makeHub(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, 'operations.md'), '# operations');
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  return root;
}
const hub = makeHub('chronicle-resolve-hub-');
const notHub = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-resolve-nothub-'));

const { resolveHub, isNisseHub, expandTilde } = await import('../server/hub/resolve.ts');

test('isNisseHub requires operations.md + records/ + governance/', () => {
  assert.equal(isNisseHub(hub), true);
  assert.equal(isNisseHub(notHub), false);
  // a partial hub (missing governance/) is not a hub
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-resolve-partial-'));
  fs.writeFileSync(path.join(partial, 'operations.md'), '#');
  fs.mkdirSync(path.join(partial, 'records'));
  assert.equal(isNisseHub(partial), false);
});

test('CHRONICLE_DEMO=1 wins over everything', () => {
  clearConfig();
  const h = resolveHub({ CHRONICLE_DEMO: '1', CHRONICLE_HUB: hub });
  assert.deepEqual(h, { mode: 'demo', root: null });
});

test('CHRONICLE_HUB resolves live and takes precedence over AIOS_HUB', () => {
  clearConfig();
  const h = resolveHub({ CHRONICLE_HUB: hub, AIOS_HUB: notHub });
  assert.equal(h.mode, 'live');
  assert.equal(h.root, path.resolve(hub));
});

test('AIOS_HUB resolves live when CHRONICLE_HUB is unset', () => {
  clearConfig();
  const h = resolveHub({ AIOS_HUB: hub });
  assert.equal(h.mode, 'live');
  assert.equal(h.root, path.resolve(hub));
});

test('config.json hubRoot resolves live when no env is set', () => {
  setConfig({ autoSync: true, hubRoot: hub });
  const h = resolveHub({});
  assert.equal(h.mode, 'live');
  assert.equal(h.root, path.resolve(hub));
});

test('absent with a helpful reason when nothing is configured', () => {
  clearConfig();
  const h = resolveHub({});
  assert.equal(h.mode, 'absent');
  assert.equal(h.root, null);
  assert.match(h.reason, /no hub configured/);
});

test('a set-but-invalid candidate is absent with a reason naming it', () => {
  clearConfig();
  const h = resolveHub({ CHRONICLE_HUB: notHub });
  assert.equal(h.mode, 'absent');
  assert.match(h.reason, /CHRONICLE_HUB/);
  assert.match(h.reason, /not a nisse-format hub/);
});

test('expandTilde maps a leading ~ to the home dir', () => {
  assert.equal(expandTilde('~'), os.homedir());
  assert.equal(expandTilde('~/x'), path.join(os.homedir(), 'x'));
  assert.equal(expandTilde('/abs/x'), '/abs/x');
});
