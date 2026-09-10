// Removal pin for the shrink (#220, #221, #222) and for context causality
// (#298): the briefing, the launcher, the memory scope-suggest runner, every
// route under the hub prefix, the routing roster, the whole write gate and the
// per-session causality read are gone, so their routes must be UNMOUNTED, not
// stubbed. A 404 here is the observable an API client sees; asserting module
// shape would pin the implementation instead of the product.
//
// The surviving routers are mounted directly rather than importing
// server/api.ts, which starts auto-sync watchers and would never let the test
// process exit.
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

// A session that really exists in the temp database. The causality pin below
// asks for it BY THIS ID so the 404 can only mean "route unmounted": a stubbed
// or re-added route that 404s unknown sessions (the shape every other
// `/sessions/:id/...` route uses) would still answer for a seeded one.
const SEEDED_SESSION = 'removed-routes-session-1';

before(async () => {
  // Dynamic, and after CHRONICLE_DATA_DIR is set above: the sessions router
  // pulls server/db.ts, which opens <dir>/chronicle.db at import time.
  const { mountSettings } = await import('../server/routes/settings.ts');
  const { mountSessions } = await import('../server/routes/sessions.ts');
  const { db, upsertProject } = await import('../server/db.ts');
  const project = upsertProject('/proj');
  db.prepare(
    `INSERT INTO sessions (id, project_id, source, file_path, message_count)
     VALUES (?, ?, 'claude-code', '/proj/session.jsonl', 0)`,
  ).run(SEEDED_SESSION, project.id);
  const app = express();
  app.use(express.json());
  mountSettings(app);
  mountSessions(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
after(() => { server?.close(); });

// The briefing and hub routers are deleted outright, so there is nothing left
// to mount: these paths can only 404. Every route the hub router used to serve
// is listed, so re-mounting any one of them fails here.
const GONE = [
  ['GET', '/briefing'],
  ['GET', '/briefing/run-status'],
  ['POST', '/briefing/action'],
  ['POST', '/briefing/run'],
  ['POST', '/launch/gap'],
  ['POST', '/memory/scope-suggest'],
  ['GET', '/memory/scope-suggest/status'],
  ['GET', '/hub/memory/summary'],
  ['GET', '/hub/status'],
  ['GET', '/hub/safety'],
  ['GET', '/hub/safety/confidential'],
  ['GET', '/hub/codegraphs'],
  ['POST', '/hub/config'],
  ['GET', '/routing'],
  // The write gate (#222). Its surviving remnant is the renamed per-boot token
  // guard, pinned in test/write-token.test.mjs.
  ['GET', '/gate/token'],
  ['GET', '/gate/surfaces'],
  ['GET', '/gate/surface'],
  ['GET', '/gate/jobs'],
  ['GET', '/gate/audit'],
  ['POST', '/gate/propose'],
  ['POST', '/gate/apply'],
  ['POST', '/gate/confirm'],
  ['POST', '/gate/undo'],
  // Context causality (#298): the heuristic read-to-change read is gone, so
  // the sessions router must not answer for it. Its neighbours on the same
  // router are asserted below, so an unmounted sessions router cannot pass.
  ['GET', `/sessions/${SEEDED_SESSION}/causality`],
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
  for (const route of ['/settings', '/sessions/minor']) {
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
