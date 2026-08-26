// Pins the Modules slice + adapter + route (CHI-323 3a). Pure slice logic +
// confidentiality refusals; the route's absent sentinel and the demo synthetic.
// CHRONICLE_DATA_DIR is a temp dir BEFORE import (resolve.ts reads config.json).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-modules-data-'));
process.env.CHRONICLE_DATA_DIR = data;

// A synthetic hub with a ## Modules table + one real product-contract.md.
function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-modules-hub-'));
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  fs.mkdirSync(path.join(root, 'projects', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'alpha', 'product-contract.md'), '# Alpha contract\n\nBody text here.\n');
  fs.writeFileSync(path.join(root, 'operations.md'), [
    '# Operations',
    '',
    '## Modules',
    '',
    '| Module | Tier | Purpose | Contract | PRD home | Project |',
    '|---|---|---|---|---|---|',
    '| alpha | core | The alpha module. | projects/alpha/product-contract.md | projects/alpha | alpha |',
    '| beta | satellite | The beta module. | (pending CHI-999) | projects/beta | beta |',
    '| gamma | core | The gamma module. | wiki/confidential/product-contract.md | x | gamma |',
    '',
    '## Something Else',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
  ].join('\n'));
  return root;
}
const hub = makeHub();

const { parseContractCell, parseModulesTable, collectModules } = await import('../server/hub/slices/modules.ts');
const { getHubAdapter } = await import('../server/hub/adapter.ts');
const { mountHub } = await import('../server/routes/hub.ts');

test('parseContractCell: pending cell', () => {
  const c = parseContractCell('(pending CHI-123)', hub);
  assert.equal(c.status, 'pending');
  assert.equal(c.pendingTicket, 'CHI-123');
  assert.equal(c.available, false);
});

test('parseContractCell: full readable contract snapshots markdown', () => {
  const c = parseContractCell('projects/alpha/product-contract.md', hub);
  assert.equal(c.status, 'full');
  assert.equal(c.available, true);
  assert.match(c.markdown, /Alpha contract/);
});

test('parseContractCell: grandfathered dagger prefix', () => {
  const c = parseContractCell('† projects/alpha/product-contract.md', hub);
  assert.equal(c.status, 'grandfathered');
  assert.equal(c.available, true);
});

test('parseContractCell: refuses a non-product-contract.md path', () => {
  const c = parseContractCell('projects/alpha/README.md', hub);
  assert.equal(c.available, false);
  assert.equal(c.markdown, null);
});

test('parseContractCell: refuses a confidential path even if named right', () => {
  const c = parseContractCell('wiki/confidential/product-contract.md', hub);
  assert.equal(c.available, false);
  assert.equal(c.markdown, null);
});

test('parseContractCell: unreadable path degrades, does not throw', () => {
  const c = parseContractCell('projects/missing/product-contract.md', hub);
  assert.equal(c.available, false);
});

test('parseModulesTable maps by header name and reads only the ## Modules table', () => {
  const md = fs.readFileSync(path.join(hub, 'operations.md'), 'utf8');
  const rows = parseModulesTable(md, hub);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'alpha');
  assert.equal(rows[0].tier, 'core');
  assert.equal(rows[0].contract.available, true);
  assert.equal(rows[1].name, 'beta');
  assert.equal(rows[1].contract.status, 'pending');
  assert.equal(rows[2].name, 'gamma');
  assert.equal(rows[2].contract.available, false); // confidential, refused
});

test('collectModules: missing operations.md yields {found:false}', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-modules-empty-'));
  const slice = collectModules(empty);
  assert.equal(slice.found, false);
  assert.deepEqual(slice.rows, []);
});

test('adapter: demo returns synthetic modules; absent returns empty', () => {
  const demo = getHubAdapter({ CHRONICLE_DEMO: '1' }).modules();
  assert.equal(demo.found, true);
  assert.ok(demo.rows.length >= 2);
  for (const r of demo.rows) assert.doesNotMatch(JSON.stringify(r), /chizhang/i); // no real hub data
  const absent = getHubAdapter({}).modules();
  assert.equal(absent.found, false);
});

test('adapter: live reads the real hub registry', () => {
  const live = getHubAdapter({ CHRONICLE_HUB: hub }).modules();
  assert.equal(live.found, true);
  assert.equal(live.rows[0].name, 'alpha');
});

// ---- route ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

test('GET /hub/modules returns the absent sentinel when no hub', async () => {
  delete process.env.CHRONICLE_HUB;
  const res = await fetch(`${baseUrl}/hub/modules`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hubPresent: false });
});

test('GET /hub/modules returns the slice when a hub is present', async () => {
  process.env.CHRONICLE_HUB = hub;
  try {
    const res = await fetch(`${baseUrl}/hub/modules`);
    const body = await res.json();
    assert.equal(body.found, true);
    assert.equal(body.rows[0].name, 'alpha');
  } finally {
    delete process.env.CHRONICLE_HUB;
  }
});
