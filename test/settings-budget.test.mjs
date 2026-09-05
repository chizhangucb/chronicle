// /settings is the server-visible home for the monthly budget. Pins the
// PATCH/GET round-trip + normalization (positive number stored; 0 / negative /
// non-number cleared to null) over the real mountSettings route on a bare
// express app. CHRONICLE_DATA_DIR is a temp dir BEFORE import so writeConfig
// touches a throwaway config.json, never the real ~/.chronicle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CHRONICLE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-settings-budget-'));

const { mountSettings } = await import('../server/routes/settings.ts');

let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountSettings(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

const getSettings = () => fetch(`${baseUrl}/settings`).then((r) => r.json());
const patch = (body) => fetch(`${baseUrl}/settings`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('monthlyBudget defaults to null when never set', async () => {
  assert.equal((await getSettings()).monthlyBudget, null);
});

test('a positive monthlyBudget round-trips through PATCH and GET', async () => {
  assert.equal((await patch({ monthlyBudget: 250 })).monthlyBudget, 250);
  assert.equal((await getSettings()).monthlyBudget, 250);
});

test('null / 0 / negative / non-number clears the budget to null', async () => {
  await patch({ monthlyBudget: 250 });
  assert.equal((await patch({ monthlyBudget: null })).monthlyBudget, null);
  await patch({ monthlyBudget: 250 });
  assert.equal((await patch({ monthlyBudget: 0 })).monthlyBudget, null);
  await patch({ monthlyBudget: 250 });
  assert.equal((await patch({ monthlyBudget: -5 })).monthlyBudget, null);
  await patch({ monthlyBudget: 250 });
  assert.equal((await patch({ monthlyBudget: 'lots' })).monthlyBudget, null);
});

test('omitting monthlyBudget in a PATCH leaves the stored value untouched', async () => {
  await patch({ monthlyBudget: 300 });
  assert.equal((await patch({ planWindows: false })).monthlyBudget, 300);
});
