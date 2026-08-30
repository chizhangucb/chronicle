// CHI-396: the app's own writes land in the write log. Drives the real
// middleware over HTTP on a bare express app (not server/api.ts, which starts
// autosync watchers and never lets the test exit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CHRONICLE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-audit-writes-'));

const { Gate } = await import('../server/gate/core.ts');
const { auditWrites } = await import('../server/gate/audit-writes.ts');

const rows = [];
const gate = new Gate({
  repoRoot: '/tmp',
  audit: { append: (r) => rows.push(r), read: (n) => rows.slice(-n) },
  backupDir: '/tmp/gate-b',
  surfaces: [],
});

let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(auditWrites(gate));
  app.patch('/settings', (_q, s) => s.json({ ok: true }));
  app.delete('/sessions/:id/source-file', (_q, s) => s.json({ ok: true }));
  app.post('/security/rules', (_q, s) => s.status(201).json({ ok: true }));
  app.post('/rejected', (_q, s) => s.status(400).json({ error: 'nope' }));
  app.post('/blew-up', (_q, s) => s.status(500).json({ error: 'boom' }));
  app.post('/view-log', (_q, s) => s.json({ ok: true }));
  app.post('/gate/propose', (_q, s) => s.json({ ok: true }));
  app.get('/settings', (_q, s) => s.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

const call = async (method, p, body) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await res.text();
  await new Promise((r) => setImmediate(r)); // let the 'finish' handler run
  return res;
};

test('a successful write is logged with its route and status', async () => {
  rows.length = 0;
  await call('PATCH', '/settings', { theme: 'dark' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'allowed');
  assert.equal(rows[0].surface, 'PATCH /settings');
  assert.equal(rows[0].detail.status, 200);
});

test('deleting a source file is logged, with the target id from the route params', async () => {
  rows.length = 0;
  await call('DELETE', '/sessions/abc-123/source-file');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, 'DELETE /sessions/:id/source-file');
  assert.equal(rows[0].detail.params.id, 'abc-123');
});

// The rule that keeps this a WRITE log rather than an error log.
test('a rejected request (4xx) writes nothing, so it is not logged', async () => {
  rows.length = 0;
  await call('POST', '/rejected');
  assert.equal(rows.length, 0);
});

test('a write that blew up mid-request IS logged, as failed', async () => {
  rows.length = 0;
  await call('POST', '/blew-up');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'failed');
  assert.equal(rows[0].detail.status, 500);
});

test('a 201 counts as a write', async () => {
  rows.length = 0;
  await call('POST', '/security/rules', { pattern: 'x' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'allowed');
});

test('reads are never logged', async () => {
  rows.length = 0;
  await call('GET', '/settings');
  assert.equal(rows.length, 0);
});

// POST /view-log fires once per navigation and is itself a log; auditing it is
// both circular and enormous.
test('the per-navigation view-log write is skipped', async () => {
  rows.length = 0;
  await call('POST', '/view-log', { events: [] });
  assert.equal(rows.length, 0);
});

test('gate routes are left to audit themselves (richer rows, with the diff)', async () => {
  rows.length = 0;
  await call('POST', '/gate/propose', { surface: 'x' });
  assert.equal(rows.length, 0);
});

// The floor: a write log must never become a content log. Bodies carry settings
// values, redaction-rule patterns and search text.
test('NO request body or query string ever reaches the audit row', async () => {
  rows.length = 0;
  // Distinctive but NOT credential-shaped: an `sk-`-style literal trips the
  // repo's confidentiality guard, and the assertion does not need a realistic
  // secret to prove a body never reaches the row.
  await call('PATCH', '/settings?secret=in-the-query', { apiKey: 'body-value-must-not-be-logged', nested: { token: 'also-not' } });
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]);
  assert.doesNotMatch(serialized, /body-value-must-not-be-logged/);
  assert.doesNotMatch(serialized, /also-not/);
  assert.doesNotMatch(serialized, /in-the-query/);
  assert.doesNotMatch(serialized, /apiKey/);
});

test('an audit-store failure never breaks the write it describes', async () => {
  const throwing = new Gate({
    repoRoot: '/tmp',
    audit: { append() { throw new Error('disk full'); }, read: () => [] },
    backupDir: '/tmp/gate-b', surfaces: [],
  });
  const app = express();
  app.use(express.json());
  app.use(auditWrites(throwing));
  app.patch('/settings', (_q, s) => s.json({ ok: true }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 200, 'the write must still succeed when logging fails');
  await new Promise((r) => srv.close(r));
});
