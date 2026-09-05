// The one test the write-token guard keeps. It runs the real
// writeTokenGuard + mountWriteToken over HTTP on a bare express app (not the
// full API), so it pins the posture without dragging in the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { writeTokenGuard, mountWriteToken, WRITE_TOKEN_HEADER } = await import('../server/writeToken.ts');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(writeTokenGuard());
  mountWriteToken(app);
  app.post('/thing', (_req, res) => res.json({ ok: true }));
  app.get('/thing', (_req, res) => res.json({ ok: true }));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function token() {
  const res = await fetch(`${baseUrl}/write-token`);
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test('GET /write-token hands out the per-boot token without needing one', async () => {
  const t = await token();
  assert.equal(typeof t, 'string');
  assert.ok(t.length > 0);
  // Stable across calls: one token per boot, not one per request.
  assert.equal(await token(), t);
});

test('GETs are exempt from the guard', async () => {
  const res = await fetch(`${baseUrl}/thing`);
  assert.equal(res.status, 200);
});

test('a mutating request without the token is 403', async () => {
  const res = await fetch(`${baseUrl}/thing`, { method: 'POST' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'bad token');
  assert.ok(body.fix);
});

test('a mutating request with a wrong token is 403', async () => {
  const res = await fetch(`${baseUrl}/thing`, {
    method: 'POST',
    headers: { [WRITE_TOKEN_HEADER]: 'nope' },
  });
  assert.equal(res.status, 403);
});

test('a mutating request carrying the token passes', async () => {
  const res = await fetch(`${baseUrl}/thing`, {
    method: 'POST',
    headers: { [WRITE_TOKEN_HEADER]: await token() },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
