// Pins the push-posture slice (CHI-379): emit-allowlist over scripts/gating_policy.json
// push_pins + push_pin_defaults, any_branch called out, scrub_whitelist is a COUNT
// never the identity regexes, adapter demo/absent/live wiring, and the route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gatingpolicy-data-'));
process.env.CHRONICLE_DATA_DIR = data;

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gatingpolicy-hub-'));
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  fs.writeFileSync(path.join(root, 'operations.md'), '# ops');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'gating_policy.json'), JSON.stringify({
    push_pins: {
      'chizhang-2': {
        remote_urls: ['https://github.com/chizhangucb/chizhang-2.git'], branches: ['main'],
        any_branch: true, confidential_ok: true, spool_refs: 'refs/ledger/spool/*',
      },
      chronicle: {
        satellite: true, visibility: 'public', remote_urls: ['https://github.com/chizhangucb/chronicle.git'],
        branches: [], feature_push_ok: true, pr_protected_branches: ['main'], leak_scrub: true,
        scrub_whitelist: ['github\\.com/chizhangucb/', '\\bchizhangucb\\b', '(?i)\\bhermes\\b'],
      },
    },
    push_pin_defaults: {
      owner_url_pattern: '^https://github\\.com/chizhangucb/[^/]+(\\.git)?$',
      defaults: {
        satellite: true, visibility: 'public', branches: [], feature_push_ok: true,
        pr_protected_branches: ['main', 'master'], leak_scrub: true,
        scrub_whitelist: ['github\\.com/chizhangucb/', '\\bchizhangucb\\b', '(?i)\\bhermes\\b'],
      },
    },
    // other top-level keys must never be opened by this slice
    self_close: { own_issue_to_done: 'conditioned-auto' },
  }));
  return root;
}
const hub = makeHub();

const { collectGatingPolicy } = await import('../server/hub/slices/gatingpolicy.ts');
const { getHubAdapter } = await import('../server/hub/adapter.ts');
const { mountHub } = await import('../server/routes/hub.ts');

test('gatingpolicy: hub any_branch pin carries anyBranch + confidentialOk, no scrub_whitelist values', () => {
  const s = collectGatingPolicy(hub);
  const hubPin = s.pushPins.find((p) => p.repo === 'chizhang-2');
  assert.equal(hubPin.anyBranch, true);
  assert.equal(hubPin.confidentialOk, true);
  assert.equal(hubPin.branches[0], 'main');
});

test('gatingpolicy: satellite pin carries featurePushOk + pr_protected_branches; scrub_whitelist is a COUNT only', () => {
  const s = collectGatingPolicy(hub);
  const sat = s.pushPins.find((p) => p.repo === 'chronicle');
  assert.equal(sat.featurePushOk, true);
  assert.deepEqual(sat.prProtectedBranches, ['main']);
  assert.equal(sat.leakScrub, true);
  assert.equal(sat.scrubWhitelistCount, 3);
  // hermes never appears anywhere outside scrub_whitelist in this fixture, so
  // its absence proves the whitelist VALUES (not just remote_urls) never leave the reader.
  assert.doesNotMatch(JSON.stringify(s), /hermes/i);
  assert.equal('scrubWhitelist' in sat, false);
});

test('gatingpolicy: owner-rule defaults are surfaced as an unbounded rule, not a repo, no identity regexes leaked', () => {
  const s = collectGatingPolicy(hub);
  assert.ok(s.pushPinDefaults);
  assert.equal(s.pushPinDefaults.ownerUrlPattern, '^https://github\\.com/chizhangucb/[^/]+(\\.git)?$');
  assert.equal(s.pushPinDefaults.featurePushOk, true);
  assert.equal(s.pushPinDefaults.scrubWhitelistCount, 3);
  assert.doesNotMatch(JSON.stringify(s.pushPinDefaults), /hermes/i);
  assert.equal('scrubWhitelist' in s.pushPinDefaults, false);
});

test('gatingpolicy: missing file fails safe (found:false, empty)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gatingpolicy-empty-'));
  assert.deepEqual(collectGatingPolicy(empty), { found: false, pushPins: [], pushPinDefaults: null });
});

test('adapter: demo gatingPolicy synthetic (no real identity strings); absent empty; live reads hub', () => {
  const demo = getHubAdapter({ CHRONICLE_DEMO: '1' });
  assert.equal(demo.gatingPolicy().found, true);
  assert.doesNotMatch(JSON.stringify(demo.gatingPolicy()), /chizhangucb|hermes/i);
  assert.equal(getHubAdapter({}).gatingPolicy().found, false);
  assert.equal(getHubAdapter({ CHRONICLE_HUB: hub }).gatingPolicy().pushPins.length, 2);
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

test('GET /hub/safety includes gatingPolicy, no identity regexes over the wire', async () => {
  process.env.CHRONICLE_HUB = hub;
  const body = await (await fetch(`${baseUrl}/hub/safety`)).json();
  assert.equal(body.gatingPolicy.found, true);
  assert.equal(body.gatingPolicy.pushPins.find((p) => p.repo === 'chizhang-2').anyBranch, true);
  // remote_urls (public GitHub URLs) legitimately carry the account handle;
  // hermes appears ONLY inside scrub_whitelist in this fixture, so its absence
  // proves the whitelist values themselves never cross the wire.
  assert.doesNotMatch(JSON.stringify(body), /hermes/i);
  delete process.env.CHRONICLE_HUB;
});
