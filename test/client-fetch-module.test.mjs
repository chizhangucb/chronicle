// The client fetch module, at its own seam (issue #307, part of #294).
//
// Every read and every write the app makes goes through src/api.ts: it names
// the URL, attaches the write token, retries the one token rotation and turns a
// non-OK response into an Error carrying the server's message. Two components
// used to call `fetch` themselves — the redaction preview and its rule list —
// and so got none of that. They call the module now, and these tests exercise
// what the module does for them.
//
// test/shared-types-single-home.test.mjs pins that no component fetches on its
// own; this file pins what routing through the module actually buys.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import { resetWriteToken, WRITE_TOKEN_HEADER } from '../src/writeToken.ts';

const realFetch = globalThis.fetch;
let calls;

// A stub server: records every request and answers from `routes`.
function stub(routes) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: (opts.method ?? 'GET').toUpperCase(), headers: opts.headers ?? {} });
    const answer = routes[url];
    if (!answer) return new Response('{}', { status: 404 });
    return typeof answer === 'function' ? answer(calls.length) : answer();
  };
}
const json = (body, status = 200) => () => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => { calls = []; resetWriteToken(); });
afterEach(() => { globalThis.fetch = realFetch; });

test('the redaction preview reads the session scan through the module', async () => {
  stub({
    '/api/sessions/s%2F1/security-check': json({ findingCount: 2, totals: { 'AWS key': 2 }, messages: [] }),
  });
  const scan = await api.securityCheck('s/1');
  assert.equal(scan.findingCount, 2);
  // The session id is encoded, so an id with a slash reaches the right route.
  assert.deepEqual(calls.map((c) => c.url), ['/api/sessions/s%2F1/security-check']);
});

test('the rule list and a rule write name the same route, and only the write carries the token', async () => {
  stub({
    '/api/security/rules': (n) => n === 1
      ? new Response(JSON.stringify([{ id: 1, pattern: 'sk-', replacement: '****', kind: 'redact', enabled: true }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/write-token': json({ token: 'tok-1' }),
  });
  const rules = await api.securityRules();
  assert.equal(rules[0].pattern, 'sk-');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/security/rules']]);

  calls = [];
  await api.createSecurityRule({ pattern: 'sk-', replacement: '****', kind: 'redact', name: 'sk-' });
  assert.deepEqual(calls.map((c) => [c.method, c.url]),
    [['GET', '/api/write-token'], ['POST', '/api/security/rules']]);
  assert.equal(calls[1].headers[WRITE_TOKEN_HEADER], 'tok-1');
});

test('a failing read surfaces the server error message', async () => {
  stub({ '/api/sessions/gone/security-check': json({ error: 'Session not found' }, 404) });
  await assert.rejects(api.securityCheck('gone'), /Session not found/);
});

test('a rotated write token is refetched once and the write retried', async () => {
  let tokens = 0;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: (opts.method ?? 'GET').toUpperCase(), headers: opts.headers ?? {} });
    if (url === '/api/write-token') {
      tokens += 1;
      return new Response(JSON.stringify({ token: `tok-${tokens}` }), { status: 200 });
    }
    // The first write carries the stale token and is refused.
    const stale = opts.headers?.[WRITE_TOKEN_HEADER] === 'tok-1';
    return new Response(JSON.stringify(stale ? { error: 'bad token' } : { ok: true }), { status: stale ? 403 : 200 });
  };
  const res = await api.deleteSecurityRule(7);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['GET', '/api/write-token'],
    ['DELETE', '/api/security/rules/7'],
    ['GET', '/api/write-token'],
    ['DELETE', '/api/security/rules/7'],
  ]);
  assert.equal(calls[3].headers[WRITE_TOKEN_HEADER], 'tok-2');
});
