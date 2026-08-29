// Confidentiality-critical pins for the memory slice (CHI-323 3e). memoryGraph
// walks the WHOLE hub markdown corpus, so the floor must hold: prune the
// confidential trees (generic `confidential` floor + the hub's declared
// segments, loaded at runtime CHI-390) however a path resolves, emit
// titles/paths only (never body text), lstat-only. A live hub with no
// declaration FAILS CLOSED. Plus the heavy-slice freshness cache + the
// adapter/route wiring. CHRONICLE_DATA_DIR is a temp dir BEFORE import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-mem-data-'));
process.env.CHRONICLE_DATA_DIR = data;

const SECRET_BODY = 'ACQUISITION_TERM_SHEET_SECRET_BODY_TEXT';
function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-mem-hub-'));
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  fs.writeFileSync(path.join(root, 'operations.md'), '# ops');
  // normal living notes (should appear as nodes; titles/paths only)
  fs.mkdirSync(path.join(root, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'alpha.md'), '# Alpha\nBody with a secret-looking phrase but non-confidential. [[beta]]\n');
  fs.writeFileSync(path.join(root, 'wiki', 'beta.md'), '# Beta\nMore body text here that must never be emitted.\n');
  // CONFIDENTIAL (generic floor): a dir literally named `confidential`, pruned
  // by the hardcoded generic floor alone.
  fs.mkdirSync(path.join(root, 'wiki', 'confidential'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'confidential', 'deal.md'), `# SecretDeal\n${SECRET_BODY}\n`);
  // CONFIDENTIAL (declared): a SYNTHETIC tree the hub names only in its private
  // declaration. Its name is never hardcoded in Chronicle source.
  fs.mkdirSync(path.join(root, 'scripts', 'egress_gate', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'egress_gate', 'data', 'confidential_segments.json'),
    JSON.stringify({ confidential_segments: ['secret-tree'] }),
  );
  fs.mkdirSync(path.join(root, 'secret-tree'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secret-tree', 'plan.md'), `# SecretPlan\n${SECRET_BODY}\n`);
  return root;
}
const hub = makeHub();

const { collectMemoryGraph } = await import('../server/hub/slices/memorygraph.ts');
const { getHubAdapter } = await import('../server/hub/adapter.ts');
const { mountHub } = await import('../server/routes/hub.ts');
const { loadConfidentialSegments, ConfidentialPolicyUnavailable } = await import('../server/hub/confidential-segments.ts');

// The prune set exactly as production loads it: generic `confidential` floor
// UNION the hub's declared segments ({ confidential, secret-tree }).
const segs = loadConfidentialSegments(hub);

test('memory slice prunes confidential trees (generic + declared) and emits NO body text', async () => {
  const slice = await collectMemoryGraph(hub, segs, {});
  const json = JSON.stringify(slice);
  // no confidential node names (generic `confidential` OR declared `secret-tree`)
  assert.doesNotMatch(json, /SecretDeal|SecretPlan/, 'confidential node leaked');
  // the declared tree name never appears in any emitted path either
  assert.doesNotMatch(json, /secret-tree/, 'declared confidential path leaked');
  // the secret BODY text never appears (nodes carry titles/paths only)
  assert.doesNotMatch(json, new RegExp(SECRET_BODY), 'body text leaked');
  // normal notes DO appear as nodes
  const names = slice.nodes.map((n) => n.name);
  assert.ok(names.includes('Alpha'), 'normal note missing');
  assert.ok(names.includes('Beta'));
});

test('no confidential path appears even in the scope dirs list', async () => {
  const slice = await collectMemoryGraph(hub, segs, {});
  // node paths are hub-relative and never inside a confidential tree
  for (const n of slice.nodes) {
    if (n.path) {
      assert.doesNotMatch(n.path, /confidential|secret-tree/i, `node path leaked: ${n.path}`);
    }
  }
});

test('adapter: demo memory is synthetic (generic-fictional, no real hub); absent is empty', async () => {
  const demo = await getHubAdapter({ CHRONICLE_DEMO: '1' }).memoryGraph();
  assert.ok(demo.nodes.length > 0);
  assert.doesNotMatch(JSON.stringify(demo), /chizhang/i);
  const absent = await getHubAdapter({}).memoryGraph();
  assert.equal(absent.nodes.length, 0);
});

test('adapter: a live hub with NO confidential declaration FAILS CLOSED', async () => {
  // A VALID nisse hub (operations.md + records/ + governance/) carrying markdown
  // and a Modules table, but with NO scripts/egress_gate/data/confidential_segments.json.
  const failHub = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-mem-failclosed-'));
  fs.mkdirSync(path.join(failHub, 'records'));
  fs.mkdirSync(path.join(failHub, 'governance'));
  fs.mkdirSync(path.join(failHub, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(failHub, 'wiki', 'alpha.md'), '# Alpha\nbody\n');
  fs.writeFileSync(path.join(failHub, 'operations.md'), [
    '# ops', '', '## Modules', '',
    '| Module | Contract |', '|---|---|',
    '| alpha | projects/alpha/product-contract.md |', '',
  ].join('\n'));

  // The loader itself throws on a live hub with no declaration (never a
  // "walk everything" default).
  assert.throws(() => loadConfidentialSegments(failHub), ConfidentialPolicyUnavailable);

  // The adapter degrades to the empty sentinels rather than walk unpruned: it has
  // markdown + a Modules table, so a non-fail-closed path WOULD emit nodes/rows.
  const mem = await getHubAdapter({ CHRONICLE_HUB: failHub }).memoryGraph();
  assert.equal(mem.nodes.length, 0, 'memory must be empty when confidential policy is unavailable');
  assert.equal(mem.links.length, 0);
  const mods = getHubAdapter({ CHRONICLE_HUB: failHub }).modules();
  assert.equal(mods.found, false, 'modules must be absent when confidential policy is unavailable');
  assert.deepEqual(mods.rows, []);
});

// ---- route ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); delete process.env.CHRONICLE_HUB; });

test('GET /hub/memory: absent sentinel, then a live slice carrying no confidential content', async () => {
  delete process.env.CHRONICLE_HUB;
  assert.deepEqual(await (await fetch(`${baseUrl}/hub/memory`)).json(), { hubPresent: false });
  process.env.CHRONICLE_HUB = hub;
  try {
    const body = await (await fetch(`${baseUrl}/hub/memory`)).json();
    assert.ok(body.nodes.length >= 2);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET_BODY));
  } finally { delete process.env.CHRONICLE_HUB; }
});

test('GET /hub/codegraphs returns a graphs array (absent sentinel when no hub)', async () => {
  delete process.env.CHRONICLE_HUB;
  assert.deepEqual(await (await fetch(`${baseUrl}/hub/codegraphs`)).json(), { hubPresent: false });
  process.env.CHRONICLE_HUB = hub;
  try {
    const body = await (await fetch(`${baseUrl}/hub/codegraphs`)).json();
    assert.ok(Array.isArray(body.graphs));
  } finally { delete process.env.CHRONICLE_HUB; }
});
