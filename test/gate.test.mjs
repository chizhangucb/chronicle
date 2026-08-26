// Gate state-machine pins, ported from Varde's test/server/gate/gate.test.ts to
// node:test (CHI-323 1b). Pure: every target is a temp file, audit is an
// in-memory store, nothing touches the real hub or the DB. Uses Chronicle's
// actual schemas (hub-gate-config for the generic direct-write path,
// hub-spend-caps for hub-script, hermes-approvals for Tier 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate, GateError, PROPOSAL_TTL_MS } from '../server/gate/core.ts';
import { SURFACES } from '../server/gate/surfaces.ts';
import { applyChange, jsonDiff, validate, viewOf } from '../server/gate/validate.ts';

/** In-memory audit store (the pure state-machine seam; production is SQLite). */
function memStore() {
  const rows = [];
  return { rows, append: (r) => rows.push(r), read: (n) => rows.slice(-n) };
}
const events = (store) => store.rows.map((r) => r.event);

// ---- generic direct-write surface (hub-gate-config schema) ----
function makeGate(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-test-'));
  const target = join(root, 'gate_config.json');
  if (overrides.config !== undefined) writeFileSync(target, JSON.stringify(overrides.config, null, 2));
  const audit = memStore();
  const gate = new Gate({
    repoRoot: root,
    audit,
    backupDir: join(root, 'gate-backups'),
    now: overrides.now,
    surfaces: [
      { id: 'test-config', title: 'Test config', target, schema: 'hub-gate-config', tier: 1, repeatable: false, secondChannel: null },
    ],
  });
  return { gate, root, target, audit };
}

test('valid change produces a proposal with an exact diff and audits proposed', () => {
  const { gate, audit } = makeGate({ config: { spend_per_tx_cap: 5 } });
  const p = gate.propose('test-config', { spend_per_tx_cap: 10 }, 'raise cap');
  assert.deepEqual(p.diff, [{ path: 'spend_per_tx_cap', from: 5, to: 10 }]);
  assert.equal(p.reason, 'raise cap');
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].event, 'proposed');
  assert.equal(audit.rows[0].surface, 'test-config');
});

test('unknown key is rejected loudly, no proposal stored', () => {
  const { gate } = makeGate({ config: {} });
  assert.throws(() => gate.propose('test-config', { nonsense: 1 }, 'x'), /not a key this surface manages/);
});

test('wrong type is rejected by the resulting-file validator', () => {
  const { gate } = makeGate({ config: {} });
  assert.throws(() => gate.propose('test-config', { enabled: 'no' }, 'x'), /invalid change|expected boolean/);
});

test('null unsets a cap', () => {
  const { gate } = makeGate({ config: { spend_per_session_cap: 50 } });
  const p = gate.propose('test-config', { spend_per_session_cap: null }, 'unset');
  assert.deepEqual(p.diff, [{ path: 'spend_per_session_cap', from: 50, to: null }]);
});

test('negative cap is rejected', () => {
  const { gate } = makeGate({ config: {} });
  assert.throws(() => gate.propose('test-config', { spend_per_tx_cap: -1 }, 'x'), /negative/);
});

test('no-op change is rejected', () => {
  const { gate } = makeGate({ config: { enabled: true } });
  assert.throws(() => gate.propose('test-config', { enabled: true }, 'x'), /no-op/);
});

test('missing target file proposes from empty object', () => {
  const { gate } = makeGate();
  const p = gate.propose('test-config', { enabled: false }, 'seed');
  assert.equal(p.before, null);
  assert.equal(JSON.parse(p.after).enabled, false);
});

test('unknown surface 404s with a fix', () => {
  const { gate } = makeGate();
  try {
    gate.propose('nope', {}, 'x');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof GateError);
    assert.equal(err.status, 404);
    assert.match(err.fix, /surfaces\.ts/);
  }
});

test('confirm backs up, writes atomically, verifies, audits', () => {
  const { gate, target, audit } = makeGate({ config: { spend_per_tx_cap: 5 } });
  const p = gate.propose('test-config', { spend_per_tx_cap: 3 }, 'test');
  const result = gate.confirm(p.id);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 3);
  assert.ok(result.backup);
  assert.equal(JSON.parse(readFileSync(result.backup, 'utf-8')).spend_per_tx_cap, 5);
  assert.deepEqual(events(audit), ['proposed', 'confirmed']);
  assert.equal(audit.rows[1].backup, result.backup);
});

test('deny leaves the file untouched and audits denied', () => {
  const { gate, target, audit } = makeGate({ config: { spend_per_tx_cap: 5 } });
  const p = gate.propose('test-config', { spend_per_tx_cap: 3 }, 'test');
  gate.deny(p.id);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 5);
  assert.deepEqual(events(audit), ['proposed', 'denied']);
});

test('confirm of an unknown id fails, nothing written', () => {
  const { gate, target } = makeGate({ config: { spend_per_tx_cap: 5 } });
  assert.throws(() => gate.confirm('deadbeef'), /unknown/);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 5);
});

test('target changed under the card: confirm refuses and audits failed', () => {
  const { gate, target, audit } = makeGate({ config: { spend_per_tx_cap: 5 } });
  const p = gate.propose('test-config', { spend_per_tx_cap: 3 }, 'test');
  writeFileSync(target, JSON.stringify({ spend_per_tx_cap: 9 }, null, 2));
  assert.throws(() => gate.confirm(p.id), /changed since/);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 9);
  assert.equal(audit.rows.at(-1).event, 'failed');
});

test('no double-confirm: second confirm of the same id fails', () => {
  const { gate } = makeGate({ config: { spend_per_tx_cap: 5 } });
  const p = gate.propose('test-config', { spend_per_tx_cap: 3 }, 'test');
  gate.confirm(p.id);
  assert.throws(() => gate.confirm(p.id), /unknown or already-settled/);
});

test('expired proposal cannot be confirmed; expiry is audited', () => {
  let clock = 1_700_000_000_000;
  const { gate, target, audit } = makeGate({ config: { spend_per_tx_cap: 5 }, now: () => clock });
  const p = gate.propose('test-config', { spend_per_tx_cap: 3 }, 'test');
  clock += PROPOSAL_TTL_MS + 1;
  try {
    gate.confirm(p.id);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 410);
  }
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 5);
  assert.deepEqual(events(audit), ['proposed', 'expired']);
});

test('sweepExpired kills stale proposals without a confirm attempt', () => {
  let clock = 1_700_000_000_000;
  const { gate, audit } = makeGate({ config: {}, now: () => clock });
  const p = gate.propose('test-config', { enabled: false }, 'test');
  assert.deepEqual(gate.sweepExpired(), []);
  clock += PROPOSAL_TTL_MS + 1;
  assert.deepEqual(gate.sweepExpired(), [p.id]);
  assert.equal(audit.rows.at(-1).event, 'expired');
});

test('jsonDiff: nested changes and additions', () => {
  assert.deepEqual(jsonDiff({ a: { b: 1 } }, { a: { b: 2 }, c: true }), [
    { path: 'a.b', from: 1, to: 2 },
    { path: 'c', from: undefined, to: true },
  ]);
});

// ---- action surfaces ----
function actionGate(impl, now) {
  const root = mkdtempSync(join(tmpdir(), 'gate-action-'));
  const audit = memStore();
  const gate = new Gate({
    repoRoot: root,
    audit,
    backupDir: join(root, 'gate-backups'),
    now,
    surfaces: [
      { id: 'test-action', title: 'Test action', target: root, schema: 'action:test', kind: 'action', tier: 1, repeatable: true, secondChannel: null },
    ],
    actions: impl ? { 'test-action': impl } : {},
  });
  return { gate, audit };
}

test('action: propose -> confirm runs execute exactly once and audits', () => {
  let runs = 0;
  const { gate, audit } = actionGate({
    describe: () => [{ path: 'job', from: 'running', to: 'paused' }],
    execute: () => { runs += 1; return 'job is now paused'; },
  });
  const p = gate.propose('test-action', { job: 'x', action: 'pause' }, 'pause it');
  assert.equal(runs, 0);
  const r = gate.confirm(p.id);
  assert.equal(runs, 1);
  assert.equal(r.applied, 'job is now paused');
  assert.deepEqual(events(audit), ['proposed', 'confirmed']);
});

test('action: execute failure audits failed and is not retried', () => {
  let runs = 0;
  const { gate, audit } = actionGate({
    describe: () => [{ path: 'job', from: 'running', to: 'paused' }],
    execute: () => { runs += 1; throw new Error('launchctl exploded'); },
  });
  const p = gate.propose('test-action', {}, 'x');
  assert.throws(() => gate.confirm(p.id), /launchctl exploded/);
  assert.equal(runs, 1);
  assert.throws(() => gate.confirm(p.id), /unknown or already-settled/);
  assert.equal(audit.rows.at(-1).event, 'failed');
});

test('action: no-op (already in target state) rejected at propose', () => {
  const { gate } = actionGate({ describe: () => [], execute: () => 'never' });
  assert.throws(() => gate.propose('test-action', {}, 'x'), /no-op/);
});

test('action: expired proposal never executes', () => {
  let clock = 1_700_000_000_000, runs = 0;
  const { gate } = actionGate({
    describe: () => [{ path: 'job', from: 'running', to: 'paused' }],
    execute: () => { runs += 1; return 'done'; },
  }, () => clock);
  const p = gate.propose('test-action', {}, 'x');
  clock += PROPOSAL_TTL_MS + 1;
  assert.throws(() => gate.confirm(p.id), /expired/);
  assert.equal(runs, 0);
});

test('action surface with no registered impl is unavailable', () => {
  const { gate } = actionGate(null);
  const s = gate.listSurfaces().find((x) => x.id === 'test-action');
  assert.equal(s.available, false);
  assert.match(s.unavailableReason, /no action implementation/);
});

// ---- hub-script surfaces ----
function hubGate(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-hub-'));
  const dataDir = join(root, 'scripts', 'egress_gate', 'data');
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'gate_config.json');
  writeFileSync(target, JSON.stringify(opts.config ?? { spend_per_tx_cap: 5 }, null, 2));
  const calls = [];
  const hubApply = opts.hubApply ?? ((payload) => {
    calls.push(payload);
    writeFileSync(target, payload.content); // fake hub script: performs the write
    return { ok: true, backup: '/tmp/fake.bak', commit: 'abc123', applied: payload.content };
  });
  const audit = memStore();
  const gate = new Gate({
    repoRoot: root, audit, backupDir: join(root, 'gate-backups'), hubRoot: root, hubApply,
    surfaces: [
      { id: 'hub-spend-caps', title: 'Spend caps', target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json', schema: 'hub-gate-config', writeVia: 'hub-script', tier: 1, repeatable: false, secondChannel: null },
    ],
  });
  return { gate, target, calls, audit };
}

test('hub-script: confirm delegates the write to the hub runner, verifies, audits with the hub backup', () => {
  const { gate, target, calls, audit } = hubGate();
  const p = gate.propose('hub-spend-caps', { spend_per_tx_cap: 10 }, 'raise cap');
  assert.deepEqual(p.diff, [{ path: 'spend_per_tx_cap', from: 5, to: 10 }]);
  const r = gate.confirm(p.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'gate_config.json');
  assert.equal(calls[0].reason, 'raise cap');
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 10);
  assert.equal(r.backup, '/tmp/fake.bak');
  assert.equal(audit.rows.at(-1).event, 'confirmed');
  assert.equal(audit.rows.at(-1).backup, '/tmp/fake.bak');
});

test('hub-script: runner failure is loud, audited failed, never retried', () => {
  let calls = 0;
  const { gate, target, audit } = hubGate({ hubApply: () => { calls += 1; return { ok: false, error: 'hub-side validation failed: nope', fix: 'fix it' }; } });
  const p = gate.propose('hub-spend-caps', { spend_per_tx_cap: 10 }, 'x');
  assert.throws(() => gate.confirm(p.id), /hub-side validation failed/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 5);
  assert.throws(() => gate.confirm(p.id), /unknown or already-settled/);
  assert.equal(audit.rows.at(-1).event, 'failed');
});

test('hub-script: verify mismatch (hub wrote something else) fails loudly', () => {
  const { gate } = hubGate({ hubApply: () => ({ ok: true, backup: '/tmp/b.bak', commit: 'x', applied: '{}' }) });
  const p = gate.propose('hub-spend-caps', { spend_per_tx_cap: 10 }, 'x');
  assert.throws(() => gate.confirm(p.id), /post-write verify failed/);
});

test('hub-script: no hub runner renders the surface disabled with the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-nohub-'));
  const gate = new Gate({
    repoRoot: root, audit: memStore(), backupDir: join(root, 'b'), hubRoot: root,
    surfaces: [
      { id: 'hub-spend-caps', title: 'Spend caps', target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json', schema: 'hub-gate-config', writeVia: 'hub-script', tier: 1, repeatable: false, secondChannel: null },
    ],
  });
  const s = gate.listSurfaces()[0];
  assert.equal(s.available, false);
  assert.match(s.unavailableReason, /hub entry point not configured/);
});

test('classification schema rejects a bad class; markers schema rejects junk', () => {
  assert.equal(validate('hub-classification', JSON.stringify({ tools: { x: { class: 'yolo' } } })).ok, false);
  assert.equal(validate('hub-classification', JSON.stringify({ tools: { x: { class: 'read' } } })).ok, true);
  assert.equal(validate('hub-confidential-markers', JSON.stringify({ strong: ['a'], ambiguous: [''] })).ok, false);
  assert.equal(validate('hub-confidential-markers', JSON.stringify({ strong: ['a'], ambiguous: ['b'] })).ok, true);
});

// ---- allow-mode ----
function allowGate(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-allow-'));
  const target = join(root, 'gate_config.json');
  writeFileSync(target, JSON.stringify(config, null, 2));
  const audit = memStore();
  const gate = new Gate({
    repoRoot: root, audit, backupDir: join(root, 'gate-backups'),
    surfaces: [
      { id: 'test-allow', title: 'Allow tunables', target, schema: 'hub-gate-config', mode: 'allow', tier: 1, repeatable: true, secondChannel: null },
    ],
  });
  return { gate, target, audit };
}

test('allow: apply writes in one shot with a single allowed audit row carrying the diff', () => {
  const { gate, target, audit } = allowGate({ enabled: true });
  const r = gate.apply('test-allow', { enabled: false }, 'kill switch');
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
  assert.deepEqual(r.diff, [{ path: 'enabled', from: true, to: false }]);
  assert.deepEqual(events(audit), ['allowed']);
  assert.equal(audit.rows[0].reason, 'kill switch');
  assert.ok(audit.rows[0].diff.length > 0);
});

test('allow: still validates - bad payload rejected, nothing written, no allowed row', () => {
  const { gate, target, audit } = allowGate({});
  assert.throws(() => gate.apply('test-allow', { nonsense: 1 }, 'r'), /not a key this surface manages/);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf-8')), {});
  assert.equal(audit.rows.length, 0);
});

test('allow: apply refuses confirm-mode surfaces', () => {
  const { gate } = makeGate({ config: {} });
  assert.throws(() => gate.apply('test-config', { enabled: false }, 'r'), /requires the confirm card/);
});

test('auditAllowed appends an allowed row with detail', () => {
  const { gate, audit } = makeGate({ config: {} });
  gate.auditAllowed('/api/launch', { method: 'POST', status: 200 });
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].event, 'allowed');
  assert.equal(audit.rows[0].surface, '/api/launch');
  assert.equal(audit.rows[0].detail.status, 200);
});

// ---- Tier 2 (hermes-approvals) ----
const YAML = [
  'provider_keys:',
  '  openrouter: sk-secret-123',
  'approvals:',
  '  mode: manual',
  '  timeout: 300',
  '  deny:',
  '    - git push*',
  '',
].join('\n');

function tier2Gate(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-t2-'));
  const target = join(root, 'config.yaml');
  if (opts.yaml !== null) writeFileSync(target, opts.yaml ?? YAML);
  const sent = [];
  const audit = memStore();
  const gate = new Gate({
    repoRoot: root, audit, backupDir: join(root, 'gate-backups'), now: opts.now,
    secondChannelSend: opts.send === null ? undefined : (opts.send ?? ((m) => (sent.push(m), { ok: true }))),
    surfaces: [
      { id: 'hermes-approvals', title: 'Hermes approvals', target, schema: 'hermes-approvals', tier: 2, repeatable: false, secondChannel: 'telegram' },
    ],
  });
  return { gate, target, sent, audit };
}
const codeFrom = (sent) => sent.at(-1).match(/Code: (\d{6})/)[1];

test('tier2: propose sends the card (diff + code), confirm needs the code, merge keeps other keys', () => {
  const { gate, target, sent } = tier2Gate();
  const p = gate.propose('hermes-approvals', { deny: ['git push*', 'rm -rf*'] }, 'add rm deny');
  assert.equal(p.requiresCode, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Tier 2/);
  assert.match(sent[0], /add rm deny/);
  assert.match(sent[0], /Code: \d{6}/);
  assert.throws(() => gate.confirm(p.id, 'operator', '000000'), /code missing or wrong/);
  gate.confirm(p.id, 'operator', codeFrom(sent));
  const text = readFileSync(target, 'utf-8');
  assert.match(text, /sk-secret-123/); // provider key untouched
  assert.match(text, /rm -rf\*/);
});

test('tier2: failed send aborts the propose loudly, nothing stored', () => {
  const { gate } = tier2Gate({ send: () => ({ ok: false, reason: 'telegram down' }) });
  assert.throws(() => gate.propose('hermes-approvals', { deny: ['x*'] }, 'r'), /could not be sent: telegram down/);
});

test('tier2: TTL expiry kills a proposal even with the right code', () => {
  let clock = 1_700_000_000_000;
  const { gate, sent, audit } = tier2Gate({ now: () => clock });
  const p = gate.propose('hermes-approvals', { deny: ['x*', 'git push*'] }, 'r');
  const code = codeFrom(sent);
  clock += PROPOSAL_TTL_MS + 1;
  assert.throws(() => gate.confirm(p.id, 'operator', code), /expired/);
  assert.equal(audit.rows.at(-1).event, 'expired');
});

test('tier2: no sender configured -> surface disabled with the reason', () => {
  const { gate } = tier2Gate({ send: null });
  const s = gate.listSurfaces()[0];
  assert.equal(s.available, false);
  assert.match(s.unavailableReason, /second channel/);
});

test('tier2: deny-glob sanity and junk keys rejected pre-card', () => {
  const { gate } = tier2Gate();
  assert.throws(() => gate.propose('hermes-approvals', { deny: ['*'] }, 'r'), /wildcards only/);
  assert.throws(() => gate.propose('hermes-approvals', { yolo: 1 }, 'r'), /not a key this surface manages/);
  assert.throws(() => gate.propose('hermes-approvals', { timeout: -5 }, 'r'), /positive number/);
});

test('tier2: missing config.yaml is a loud propose error', () => {
  const { gate } = tier2Gate({ yaml: null });
  assert.throws(() => gate.propose('hermes-approvals', { deny: ['x*'] }, 'r'), /hermes setup/);
});

test('tier2: view exposes only the approvals block, never the provider keys', () => {
  const view = viewOf('hermes-approvals', YAML);
  assert.match(view, /git push\*/);
  assert.doesNotMatch(view, /sk-secret-123/);
});

// ---- foreign-key pass-through ----
test('hub-gate-config: foreign keys survive a managed change and validation', () => {
  const current = JSON.stringify({ enabled: true, spend_per_tx_cap: 5, unclassified_deny_daily_cap: 25, _comment: 'gate knob' });
  const { after, diff } = applyChange('hub-gate-config', current, { enabled: false });
  const obj = JSON.parse(after);
  assert.equal(obj.unclassified_deny_daily_cap, 25);
  assert.equal(obj._comment, 'gate knob');
  assert.equal(obj.enabled, false);
  assert.deepEqual(diff, [{ path: 'enabled', from: true, to: false }]);
  assert.equal(validate('hub-gate-config', after).ok, true);
});

test('hub-gate-config: a change may only carry the managed keys', () => {
  assert.throws(() => applyChange('hub-gate-config', '{}', { unclassified_deny_daily_cap: 1 }), /not a key this surface manages/);
});

test('hermes-approvals: unknown approvals keys from a newer Hermes ride through', () => {
  const cfgText = 'approvals:\n  mode: manual\n  future_knob: 3\n';
  const { after } = applyChange('hermes-approvals', cfgText, { timeout: 60 });
  assert.match(after, /future_knob/);
  assert.equal(validate('hermes-approvals', after).ok, true);
});

// ---- surface registry ----
test('surface registry: SURFACES has no Varde-only aggregator-config, hub-egress-enabled is wired', () => {
  assert.equal(SURFACES.some((s) => s.id === 'aggregator-config'), false);
  const egress = SURFACES.find((s) => s.id === 'hub-egress-enabled');
  assert.ok(egress);
  assert.equal(egress.schema, 'hub-gate-config');
  assert.equal(egress.writeVia, 'hub-script');
  // hub surfaces use ${AIOS_HUB}, never a baked personal path
  for (const s of SURFACES) assert.doesNotMatch(s.target, /chizhang/);
});
