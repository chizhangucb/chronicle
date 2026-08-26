// Pins the Safety slices + adapter + routes + launcher (CHI-323 3d). Emphasis on
// the confidentiality hardening: emit-allowlist (not denylist), value creds
// scan, markers as COUNTS, and the D8 hard gate on the confidential drill-down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-safety-data-'));
process.env.CHRONICLE_DATA_DIR = data;

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-safety-hub-'));
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  fs.writeFileSync(path.join(root, 'operations.md'), '# ops');
  const gate = path.join(root, 'scripts', 'egress_gate', 'data');
  fs.mkdirSync(gate, { recursive: true });
  // gate_config: two managed caps + a PLANTED secret under an innocuous key.
  fs.writeFileSync(path.join(gate, 'gate_config.json'), JSON.stringify({
    enabled: true, spend_per_tx_cap: 5, spend_per_session_cap: 50,
    authorization: 'Bearer sk-live-abcdefghijklmnop', internal_note: 'ok',
  }));
  fs.writeFileSync(path.join(gate, 'classification.json'), JSON.stringify({
    tools: { 'web.fetch': { class: 'read', secret_hint: 'sk-should-not-leak-000000000000' }, 'mail.send': { class: 'send' }, weird: { class: 'yolo' } },
  }));
  fs.writeFileSync(path.join(gate, 'confidential_markers.json'), JSON.stringify({
    _comment: 'x', strong: ['cap table', 'term sheet', 'runway'], ambiguous: ['board'],
  }));
  fs.writeFileSync(path.join(gate, 'proxy_servers.json'), JSON.stringify({ 'router-a': { url: 'https://u:p@host' }, _c: 1 }));
  return root;
}
const hub = makeHub();

const { collectSafetyNet } = await import('../server/hub/slices/safetynet.ts');
const { collectEgress } = await import('../server/hub/slices/egress.ts');
const { collectSafetyGaps } = await import('../server/hub/slices/gaps.ts');
const { readConfidentialMarkers, confidentialMarkersEnabled } = await import('../server/hub/slices/confidential.ts');
const { shellQuote, buildLaunchCommand, gapReviewPrompt } = await import('../server/launch.ts');
const { getHubAdapter } = await import('../server/hub/adapter.ts');
const { mountHub } = await import('../server/routes/hub.ts');
const { safetyGapsRegisterPath } = await import('../server/hub/paths.ts');

test('safetynet emit-allowlist: gate_config keeps only the four knobs, drops the planted secret', () => {
  const s = collectSafetyNet(hub);
  assert.deepEqual(s.gateConfig, { enabled: true, spend_per_tx_cap: 5, spend_per_session_cap: 50, unclassified_deny_daily_cap: null });
  // no innocuous-key creds leak
  assert.doesNotMatch(JSON.stringify(s), /Bearer|sk-live|internal_note/);
});

test('safetynet classification: only {name,class} for known buckets, extras dropped', () => {
  const s = collectSafetyNet(hub);
  const names = s.classification.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mail.send', 'web.fetch']); // "weird" (class yolo) dropped
  assert.doesNotMatch(JSON.stringify(s.classification), /secret_hint|sk-should-not-leak/);
});

test('safetynet markers are COUNTS only, never phrases; proxy is names only', () => {
  const s = collectSafetyNet(hub);
  assert.deepEqual(s.markers.categories.sort((a, b) => a.category.localeCompare(b.category)), [{ category: 'ambiguous', count: 1 }, { category: 'strong', count: 3 }]);
  assert.doesNotMatch(JSON.stringify(s.markers), /cap table|term sheet|runway/);
  assert.deepEqual(s.proxyServers, { names: ['router-a'] });
});

test('egress reads enabled; missing file fails safe (enabled:true, found:false)', () => {
  assert.deepEqual(collectEgress(hub), { enabled: true, gateConfigFound: true });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-safety-noegress-'));
  assert.deepEqual(collectEgress(empty), { enabled: true, gateConfigFound: false });
});

test('gaps register parses, splits actionable/watch, derives posture', () => {
  const net = collectSafetyNet(hub);
  const slice = collectSafetyGaps(safetyGapsRegisterPath(), net, true);
  assert.ok(slice.actionable.length >= 1);
  assert.equal(slice.posture.classificationRules, 2);
  assert.equal(slice.posture.egressEnabled, true);
});

test('confidential markers: phrases readable directly, but hard-gated by policy (D8)', () => {
  const m = readConfidentialMarkers(hub);
  assert.ok(m.categories.find((c) => c.category === 'strong').phrases.includes('cap table'));
  // default build: OFF regardless of flag when demo/absent; live needs opt-in
  assert.equal(confidentialMarkersEnabled('demo', {}, true), false);
  assert.equal(confidentialMarkersEnabled('absent', { CHRONICLE_CONFIDENTIAL_MARKERS: '1' }, true), false);
  assert.equal(confidentialMarkersEnabled('live', {}, undefined), false); // default OFF
  assert.equal(confidentialMarkersEnabled('live', {}, true), true); // config opt-in
  assert.equal(confidentialMarkersEnabled('live', { CHRONICLE_CONFIDENTIAL_MARKERS: '1' }, undefined), true); // env opt-in
});

test('launcher builders: shell-quote + print -z buffer, gap prompt is server-built', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const cmd = buildLaunchCommand('review this gap', '/tmp/hub');
  assert.match(cmd.buffer, /^cd '\/tmp\/hub' && claude 'review this gap'$/);
  assert.equal(cmd.osascriptArgs[0], '-e');
  assert.match(cmd.osascriptArgs[1], /print -z/);
  const p = gapReviewPrompt({ title: 'X', exposure: 'Y' }, false);
  assert.match(p, /actionable safety gap "X"/);
});

test('adapter: demo safety synthetic (no real hub data); absent empty; live reads hub', () => {
  const demo = getHubAdapter({ CHRONICLE_DEMO: '1' });
  assert.ok(demo.safetyNet().classification.tools.length > 0);
  assert.doesNotMatch(JSON.stringify(demo.safetyNet()), /chizhang|cap table/);
  assert.equal(getHubAdapter({}).safetyNet().found, false);
  assert.equal(getHubAdapter({ CHRONICLE_HUB: hub }).safetyNet().gateConfig.spend_per_tx_cap, 5);
});

// ---- routes ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); delete process.env.CHRONICLE_HUB; });

test('GET /hub/safety: absent sentinel, then present', async () => {
  delete process.env.CHRONICLE_HUB;
  assert.deepEqual(await (await fetch(`${baseUrl}/hub/safety`)).json(), { hubPresent: false });
  process.env.CHRONICLE_HUB = hub;
  const body = await (await fetch(`${baseUrl}/hub/safety`)).json();
  assert.equal(body.egress.enabled, true);
  assert.equal(body.safetyNet.gateConfig.spend_per_tx_cap, 5);
  delete process.env.CHRONICLE_HUB;
});

test('GET /hub/safety/confidential is 403 by default (public build never serves it)', async () => {
  process.env.CHRONICLE_HUB = hub;
  try {
    const res = await fetch(`${baseUrl}/hub/safety/confidential`);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not enabled/);
  } finally { delete process.env.CHRONICLE_HUB; }
});

test('POST /launch/gap refuses demo with 409', async () => {
  process.env.CHRONICLE_DEMO = '1';
  try {
    const res = await fetch(`${baseUrl}/launch/gap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'spend-caps-unset' }) });
    assert.equal(res.status, 409);
  } finally { delete process.env.CHRONICLE_DEMO; }
});
