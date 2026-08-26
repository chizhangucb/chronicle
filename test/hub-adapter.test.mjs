// Pins for the hub adapter factory (server/hub/adapter.ts): the right adapter
// per environment, and the status() shape the client gates ops nav on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-adapter-data-'));
process.env.CHRONICLE_DATA_DIR = data;

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-adapter-hub-'));
  fs.writeFileSync(path.join(root, 'operations.md'), '# operations');
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  return root;
}
const hub = makeHub();

const { getHubAdapter, LiveHubAdapter, DemoHubAdapter, NullHubAdapter } =
  await import('../server/hub/adapter.ts');

test('demo env -> DemoHubAdapter, status present + mode demo', () => {
  const a = getHubAdapter({ CHRONICLE_DEMO: '1' });
  assert.ok(a instanceof DemoHubAdapter);
  assert.deepEqual(a.status(), { present: true, mode: 'demo', root: null });
});

test('live env -> LiveHubAdapter, status carries the resolved root', () => {
  const a = getHubAdapter({ CHRONICLE_HUB: hub });
  assert.ok(a instanceof LiveHubAdapter);
  assert.deepEqual(a.status(), { present: true, mode: 'live', root: path.resolve(hub) });
});

test('no hub -> NullHubAdapter, status absent (client hides ops nav)', () => {
  const a = getHubAdapter({});
  assert.ok(a instanceof NullHubAdapter);
  const s = a.status();
  assert.equal(s.present, false);
  assert.equal(s.mode, 'absent');
  assert.equal(s.root, null);
  assert.match(s.reason, /no hub configured/);
});
