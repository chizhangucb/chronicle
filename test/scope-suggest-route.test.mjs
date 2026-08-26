// Pins the scope-suggest runner's pure functions + the route's guards
// (CHI-339). No live `claude` binary is exercised (mirrors briefing.test.mjs:
// only the demo/absent-hub refusals are tested, never an actual spawn).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-scopesuggest-data-'));
process.env.CHRONICLE_DATA_DIR = data;

const { hubStructure, buildPrompt, validateSuggestion } = await import('../scripts/run-scope-suggest.ts');
const { mountHub } = await import('../server/routes/hub.ts');

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-scopesuggest-hub-'));
  fs.mkdirSync(path.join(root, 'wiki', 'entities'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'entities', 'x.md'), '# X');
  fs.mkdirSync(path.join(root, 'wiki', 'confidential'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'confidential', 'deal.md'), '# SecretDeal');
  fs.mkdirSync(path.join(root, 'next-ventures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'next-ventures', 'plan.md'), '# NextVenture');
  fs.mkdirSync(path.join(root, 'governance'), { recursive: true });
  fs.mkdirSync(path.join(root, 'records'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operations.md'), '# ops');
  return root;
}
const hub = makeHub();

// ---- pure functions ----
test('hubStructure: absent root -> empty; lists dirs/root .md, hides confidential/next-ventures', () => {
  assert.equal(hubStructure(null), '');
  const structure = hubStructure(hub);
  assert.match(structure, /wiki\//);
  assert.match(structure, /governance\//);
  assert.match(structure, /operations\.md/);
  assert.doesNotMatch(structure, /confidential/);
  assert.doesNotMatch(structure, /next-ventures/);
  assert.doesNotMatch(structure, /SecretDeal|NextVenture/);
});

test('buildPrompt embeds the structure and demands a bare JSON object reply', () => {
  const prompt = buildPrompt('wiki/\ngovernance/');
  assert.match(prompt, /wiki\//);
  assert.match(prompt, /No prose, no markdown fences/);
});

test('validateSuggestion: accepts a clean tier mapping, trims trailing slashes', () => {
  const out = validateSuggestion({ living: ['wiki/'], historical: ['records/decisions*'], excluded: ['plans'] });
  assert.deepEqual(out, { living: ['wiki'], historical: ['records/decisions*'], excluded: ['plans'] });
});

test('validateSuggestion: rejects a missing tier, a non-array, an absolute/relative-escape pattern', () => {
  assert.throws(() => validateSuggestion({ living: [], historical: [] }), /excluded/);
  assert.throws(() => validateSuggestion({ living: 'wiki', historical: [], excluded: [] }), /living/);
  assert.throws(() => validateSuggestion({ living: ['/etc/passwd'], historical: [], excluded: [] }), /hub-relative/);
  assert.throws(() => validateSuggestion({ living: ['../secret'], historical: [], excluded: [] }), /hub-relative/);
});

// ---- route ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); delete process.env.CHRONICLE_HUB; delete process.env.CHRONICLE_DEMO; });

test('POST /memory/scope-suggest: no hub connected -> 409', async () => {
  delete process.env.CHRONICLE_HUB;
  delete process.env.CHRONICLE_DEMO;
  const res = await fetch(`${baseUrl}/memory/scope-suggest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no hub connected/);
});

test('POST /memory/scope-suggest: demo seed -> 409 (checked before single-flight)', async () => {
  process.env.CHRONICLE_DEMO = '1';
  try {
    const res = await fetch(`${baseUrl}/memory/scope-suggest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /demo seed/);
  } finally { delete process.env.CHRONICLE_DEMO; }
});

test('GET /memory/scope-suggest/status: returns the running/suggestion/error shape, never cached', async () => {
  const res = await fetch(`${baseUrl}/memory/scope-suggest/status`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.running, false);
  assert.equal(body.suggestion, null);
});
