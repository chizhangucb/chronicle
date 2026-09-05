// #220 removal pin: the briefing, the launcher and the memory scope-suggest
// runner are gone, so their routes must be UNMOUNTED, not stubbed. A 404 here
// is the observable an API client sees; asserting module shape would pin the
// implementation instead of the product.
//
// The routers are mounted directly (the same pattern as hub-route/gate-routes)
// rather than importing server/api.ts, which starts auto-sync watchers and a
// console gate and would never let the test process exit.
//
// The surviving neighbours are asserted in the same run so a wholesale
// mis-mount (an app that answers 404 for everything) cannot pass this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-removed-'));
process.env.CHRONICLE_DATA_DIR = data;

let server, baseUrl;

before(async () => {
  const { mountHub } = await import('../server/routes/hub.ts');
  const { mountSettings } = await import('../server/routes/settings.ts');
  const app = express();
  app.use(express.json());
  mountHub(app);
  mountSettings(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
after(() => { server?.close(); });

// The briefing router is deleted outright, so there is nothing left to mount:
// these paths can only 404. The hub router survives (#221 removes it), which is
// why its launcher, scope-suggest and band-summary routes are pinned here.
const GONE = [
  ['GET', '/briefing'],
  ['GET', '/briefing/run-status'],
  ['POST', '/briefing/action'],
  ['POST', '/briefing/run'],
  ['POST', '/launch/gap'],
  ['POST', '/memory/scope-suggest'],
  ['GET', '/memory/scope-suggest/status'],
  ['GET', '/hub/memory/summary'],
];

test('every removed route is unmounted (404)', async () => {
  for (const [method, route] of GONE) {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(res.status, 404, `${method} ${route} answered ${res.status}, not 404`);
  }
});

test('the surviving neighbours on the same routers still answer', async () => {
  for (const route of ['/hub/status', '/settings']) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.ok, true, `${route} answered ${res.status}`);
  }
});

test('/settings no longer carries the homeBands toggle', async () => {
  const cfg = await (await fetch(`${baseUrl}/settings`)).json();
  assert.equal('homeBands' in cfg, false);
});

test('no briefing or briefing-state file is written under the data dir', async () => {
  await fetch(`${baseUrl}/settings`);
  const files = fs.readdirSync(data);
  assert.equal(files.some((f) => f.startsWith('briefing')), false, `data dir holds ${files.join(', ')}`);
});
