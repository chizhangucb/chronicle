// Pins for the hub route (server/routes/hub.ts): status gating + the setup
// affordance's config MERGE. The merge is load-bearing (review #1): config.json
// already holds autosync/noise-gate keys, so writing hubRoot must never clobber
// them. Drives the real route over HTTP. CHRONICLE_DATA_DIR is set to a temp dir
// BEFORE import so config.json + the DB land there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-hubroute-'));
process.env.CHRONICLE_DATA_DIR = data;
const CONFIG = path.join(data, 'config.json');
const readConfigFile = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-hubroute-hub-'));
  fs.writeFileSync(path.join(root, 'operations.md'), '# operations');
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  return root;
}
const hub = makeHub();

let server, baseUrl;

before(async () => {
  // Seed an existing config (autosync + noise-gate keys) the merge must preserve.
  fs.writeFileSync(CONFIG, JSON.stringify({ autoSync: false, minorMessageCountThreshold: 7 }));
  const { mountHub } = await import('../server/routes/hub.ts');
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
});

const status = async () => (await fetch(`${baseUrl}/hub/status`)).json();
const setHub = (hubRoot) =>
  fetch(`${baseUrl}/hub/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hubRoot }),
  });

test('status reports absent before a hub is configured', async () => {
  const s = await status();
  assert.equal(s.present, false);
  assert.equal(s.mode, 'absent');
});

test('setup writes hubRoot and reports live', async () => {
  const res = await setHub(hub);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'live');
  assert.equal(body.root, path.resolve(hub));
  const s = await status();
  assert.equal(s.present, true);
  assert.equal(s.mode, 'live');
});

test('the merge PRESERVES the existing autosync / noise-gate keys (review #1)', () => {
  const cfg = readConfigFile();
  assert.equal(cfg.hubRoot, path.resolve(hub));
  assert.equal(cfg.autoSync, false, 'autoSync was clobbered');
  assert.equal(cfg.minorMessageCountThreshold, 7, 'noise-gate threshold was clobbered');
});

test('an invalid path is refused with 400 and does not write hubRoot', async () => {
  const notHub = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-hubroute-nothub-'));
  // First clear so a prior hubRoot isn't what we observe.
  await fetch(`${baseUrl}/hub/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hubRoot: '' }),
  });
  const res = await setHub(notHub);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(Array.isArray(body.expected));
  assert.equal(readConfigFile().hubRoot, undefined);
});

test('clearing hubRoot returns to absent but keeps other keys', async () => {
  await setHub(hub);
  assert.equal(readConfigFile().hubRoot, path.resolve(hub));
  await fetch(`${baseUrl}/hub/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hubRoot: '' }),
  });
  const cfg = readConfigFile();
  assert.equal(cfg.hubRoot, undefined);
  assert.equal(cfg.autoSync, false); // preserved through the clear
  assert.equal((await status()).mode, 'absent');
});

// #218 regression pin (#215 Testing Decisions: "assertions that every removed
// route path returns 404"). The Modules, Jobs and Records surfaces are gone;
// their slice routes must be UNMOUNTED, not merely returning an absent
// sentinel. A sentinel would mean the route is still there and the page could
// be revived by re-adding a component. Asserted with a hub CONFIGURED, so a
// 404 cannot be an accident of the absent-hub guard.
test('the removed Modules/Jobs/Records routes are unmounted, not sentinel-guarded', async () => {
  await setHub(hub);
  assert.equal((await status()).present, true, 'guard: the hub must be live for this to prove anything');

  for (const route of ['/hub/modules', '/hub/jobs', '/hub/records', '/jobs/log?id=anything']) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 404, `${route} must 404, not answer`);
  }

  // The surviving slice route still answers on the same live hub, so the 404s
  // above are the removal and not a broken mount.
  assert.equal((await fetch(`${baseUrl}/hub/safety`)).status, 200);
});
