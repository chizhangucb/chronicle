// Pins the gate transport + the global write guard (CHI-323 1b, D2): a mutating
// request needs the per-boot token; GETs (incl. the token GET) do not. Drives
// the real gateTokenGuard + mountGateRoutes over HTTP on a bare express app (not
// server/api.ts, which would start autosync watchers and never let the test
// exit). CHRONICLE_DATA_DIR is a temp dir BEFORE import (routes.ts -> audit-store
// self-creates the gate_audit table in the DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CHRONICLE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gate-routes-'));

const { Gate } = await import('../server/gate/core.ts');
const { mountGateRoutes, gateTokenGuard } = await import('../server/gate/routes.ts');

const gate = new Gate({
  repoRoot: '/tmp', audit: { append() {}, read: () => [] }, backupDir: '/tmp/gate-b', surfaces: [],
});

let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(gateTokenGuard(gate));
  mountGateRoutes(app, gate);
  app.post('/dummy', (_req, res) => res.json({ ok: true })); // stands in for any existing write
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

const post = (p, token) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-gate-token': token } : {}) },
    body: '{}',
  });

test('GET /gate/token returns the per-boot token (no token needed)', async () => {
  const res = await fetch(`${baseUrl}/gate/token`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.token, gate.token);
  assert.ok(body.token.length >= 32);
});

test('a mutating request with NO token is refused 403', async () => {
  const res = await post('/dummy');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'bad token');
});

test('a mutating request with the WRONG token is refused 403', async () => {
  const res = await post('/dummy', 'not-the-token');
  assert.equal(res.status, 403);
});

test('a mutating request with the right token passes', async () => {
  const res = await post('/dummy', gate.token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('the gate own POST routes are guarded too (propose without token -> 403)', async () => {
  const res = await post('/gate/propose');
  assert.equal(res.status, 403);
});

test('read-only gate GETs never require the token', async () => {
  for (const p of ['/gate/surfaces', '/gate/audit']) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 200, `${p} should be reachable without a token`);
  }
});

// ---- CHI-329: the transport reports the policy's decision ----

test('POST /gate/propose answers {applied:true} for an auto change and never leaves a card', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-auto-'));
  const target = path.join(dir, 'gate_config.json');
  fs.writeFileSync(target, JSON.stringify({ enabled: true }));
  const rows = [];
  const g2 = new Gate({
    repoRoot: dir, audit: { append: (r) => rows.push(r), read: (n) => rows.slice(-n) },
    backupDir: path.join(dir, 'b'),
    surfaces: [{ id: 'auto', title: 'Auto', target, schema: 'hub-gate-config', approval: 'auto', tier: 1, secondChannel: null }],
  });
  const app2 = express();
  app2.use(express.json());
  mountGateRoutes(app2, g2);
  const srv = app2.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${url}/gate/propose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gate-token': g2.token },
    body: JSON.stringify({ surface: 'auto', change: { enabled: false }, reason: 'off' }),
  });
  const body = await res.json();
  assert.equal(body.applied, true);
  assert.ok(!body.proposal, 'an auto change must not hand back a card');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).enabled, false);
  await new Promise((r) => srv.close(r));
});

test('POST /gate/undo is token-guarded like every other write', async () => {
  const res = await post('/gate/undo');
  assert.equal(res.status, 403);
});
