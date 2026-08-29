// CHI-329: the tiering policy and its floors. Every test here is a floor pin:
// if one of these goes red, a write that should have shown a card stopped
// showing one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate } from '../server/gate/core.ts';
import { PROTECTED_JOB_PATTERNS, isProtectedJob, narrowLaunchd } from '../server/gate/approval.ts';

function memStore() {
  const rows = [];
  return { rows, append: (r) => rows.push(r), read: (n) => rows.slice(-n) };
}

function gateWith(surfaces, { config = {}, demo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-approval-'));
  const target = join(root, 'gate_config.json');
  writeFileSync(target, JSON.stringify(config, null, 2));
  const audit = memStore();
  const resolved = surfaces.map((s) => ({ target, schema: 'hub-gate-config', tier: 1, secondChannel: null, ...s }));
  const gate = new Gate({ repoRoot: root, audit, backupDir: join(root, 'gate-backups'), surfaces: resolved, demo });
  return { gate, target, audit, root };
}

const AUTO = { id: 'auto-surface', title: 'Auto', approval: 'auto' };
const CARDED = { id: 'carded-surface', title: 'Carded', approval: 'confirm' };

// ---- narrowLaunchd ----

// Synthetic labels. Real machine labels never appear in this repo: Chronicle
// ships publicly, and one operator's job names are neither publishable nor
// meaningful to anyone else.
const CRITICAL = [
  'ai.hermes.gateway',
  'com.example.egress-resend-listener',
  'com.example.daily-maintenance',
  'com.example.hygiene-fix',
];
const ORDINARY = ['com.example.graphify-update', 'com.example.photo-sync'];

test('narrowLaunchd: resume is always fine, even for a protected job', () => {
  for (const label of CRITICAL) {
    assert.equal(narrowLaunchd({ action: 'resume', label }, []), null);
  }
});

test('narrowLaunchd: pausing an ordinary job stays auto', () => {
  for (const label of ORDINARY) {
    assert.equal(narrowLaunchd({ action: 'pause', label }, []), null, `${label} should not card`);
  }
});

test('narrowLaunchd: pausing enforcement or reporting machinery cards, with a reason', () => {
  for (const label of CRITICAL) {
    const reason = narrowLaunchd({ action: 'pause', label }, []);
    assert.ok(reason, `${label} must card on pause`);
    assert.ok(typeof reason === 'string' && reason.length > 10);
  }
});

test('narrowLaunchd: the approval channel says WHY it matters (it carries every card)', () => {
  assert.match(narrowLaunchd({ action: 'pause', label: 'ai.hermes.gateway' }, []), /confirmation card/i);
});

test('narrowLaunchd: a junk payload never silently auto-approves a protected pause', () => {
  assert.equal(narrowLaunchd(null, []), null); // no action -> not a pause
  assert.equal(narrowLaunchd({ action: 'pause' }, []), null); // no label -> nothing to match
});

// The anti-theatre pin. An earlier draft listed one machine's exact labels with
// prefix globs that matched ZERO installed jobs: protection in name only, and a
// leak of that machine's setup into a public package. Patterns describe what a
// job DOES, so they generalise. This asserts they still match the shapes they
// exist for.
test('PROTECTED_JOB_PATTERNS match by function, and carry no personal or machine-specific names', () => {
  for (const p of PROTECTED_JOB_PATTERNS) {
    assert.ok(!p.includes('*'), `${p}: substring match, not a glob`);
    assert.equal(p, p.toLowerCase(), `${p}: patterns are matched case-insensitively, keep them lowercase`);
    assert.doesNotMatch(p, /^(com|ai|org)\./, `${p}: a reverse-DNS prefix means this is a specific job, not a function`);
  }
  // matching is case-insensitive and substring-based, wherever the word sits
  assert.ok(isProtectedJob('COM.EXAMPLE.Hermes-Gateway'));
  assert.ok(isProtectedJob('com.example.nightly-backup'));
  assert.ok(!isProtectedJob('com.example.wallpaper-rotator'));
});

// Guards the public-package floor directly: no test and no shipped source may
// carry a real operator's job labels.
test('the approval module names no real machine', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/gate/approval.ts', import.meta.url), 'utf-8');
  assert.doesNotMatch(src, /chizhang/i);
});

// ---- the floors ----

test('floor: a surface with NO approval field gets the card (fail closed)', () => {
  const { gate } = gateWith([{ id: 'undeclared', title: 'Undeclared' }]);
  const out = gate.submit('undeclared', { enabled: false }, 'r');
  assert.equal(out.applied, false);
  assert.match(out.proposal.cardReason, /always shows the card/);
});

test('floor: Tier 2 never auto-approves, even declaring approval:auto', () => {
  const { gate } = gateWith([{ id: 't2', title: 'T2', approval: 'auto', tier: 2, secondChannel: 'telegram' }]);
  const v = gate.resolveApproval(gate.listSurfaces().find((s) => s.id === 't2'), {}, [{ path: 'a', from: 1, to: 2 }]);
  assert.equal(v.auto, false);
  assert.match(v.cardReason, /Tier 2/);
});

test('floor: a hub-script surface declaring approval:auto throws at CONSTRUCTION', () => {
  assert.throws(
    () => gateWith([{ id: 'hub', title: 'Hub', approval: 'auto', writeVia: 'hub-script' }]),
    /never auto-writes the hub/,
  );
});

test('floor: a narrow() that throws cards the change (fails closed, never open)', () => {
  const { gate } = gateWith([{ ...AUTO, narrow: () => { throw new Error('boom'); } }]);
  const out = gate.submit('auto-surface', { enabled: false }, 'r');
  assert.equal(out.applied, false);
  assert.match(out.proposal.cardReason, /could not classify/);
});

test('floor: model-generated content cards on EVERY surface, including auto ones', () => {
  const { gate, target } = gateWith([AUTO], { config: { enabled: true } });
  const out = gate.submit('auto-surface', { enabled: false }, 'suggested scope', 'suggestion');
  assert.equal(out.applied, false);
  assert.match(out.proposal.cardReason, /generated by a model/);
  // and nothing was written
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, true);
});

test('floor: demo refuses both paths on an auto surface', () => {
  const { gate } = gateWith([AUTO], { demo: true });
  assert.throws(() => gate.submit('auto-surface', { enabled: false }, 'r'), /demo/);
  assert.throws(() => gate.apply('auto-surface', { enabled: false }, 'r'), /demo/);
});

// ---- submit: the single decision point ----

test('submit: an auto change applies inline, one allowed row, NO stored proposal', () => {
  const { gate, target, audit } = gateWith([AUTO], { config: { enabled: true } });
  const out = gate.submit('auto-surface', { enabled: false }, 'kill switch');
  assert.equal(out.applied, true);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
  assert.deepEqual(audit.rows.map((r) => r.event), ['allowed']);
  // no card was left behind to confirm later
  assert.throws(() => gate.confirm(out.result.target), /unknown or already-settled/);
});

test('submit: a carded change stores a proposal and writes nothing yet', () => {
  const { gate, target, audit } = gateWith([CARDED], { config: { enabled: true } });
  const out = gate.submit('carded-surface', { enabled: false }, 'r');
  assert.equal(out.applied, false);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, true);
  assert.deepEqual(audit.rows.map((r) => r.event), ['proposed']);
  gate.confirm(out.proposal.id);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
});

// M3 regression pin: audit suppression used to be a single instance flag, so
// two overlapping auto-applies swallowed each other's rows. apply() no longer
// routes through propose()/confirm(), so there is no flag to race.
test('two auto-applies in a row each leave their own audit row', () => {
  const { gate, audit } = gateWith([AUTO], { config: { enabled: true } });
  gate.apply('auto-surface', { enabled: false }, 'first');
  gate.apply('auto-surface', { enabled: true }, 'second');
  assert.deepEqual(audit.rows.map((r) => r.event), ['allowed', 'allowed']);
  assert.deepEqual(audit.rows.map((r) => r.reason), ['first', 'second']);
});

// ---- undo ----

test('undo: restores an auto write and records the restore as its own row', () => {
  const { gate, target, audit } = gateWith([AUTO], { config: { enabled: true } });
  const first = gate.apply('auto-surface', { enabled: false }, 'turn off');
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
  const row = audit.rows.at(-1);
  const out = gate.undo(row.proposalId);
  assert.equal(out.applied, true);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, true);
  assert.equal(audit.rows.length, 2);
  assert.match(audit.rows.at(-1).reason, /^undo of the allowed write/);
  assert.ok(first.backup);
});

// B3 pin: undo is NOT its own approval category. On a carded surface the
// restore meets the same policy the original write did.
test('undo: on a carded surface the restore ALSO shows a card', () => {
  const { gate, target, audit } = gateWith([CARDED], { config: { enabled: true } });
  const p = gate.propose('carded-surface', { enabled: false }, 'off');
  gate.confirm(p.id);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
  const row = audit.rows.find((r) => r.event === 'confirmed');
  const out = gate.undo(row.proposalId);
  assert.equal(out.applied, false, 'an undo must never skip a card the surface requires');
  // still not written: the card is pending
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).enabled, false);
});

// B4 pin: .bak files are ordinary user-writable files and validate() is only a
// shape check, so a tampered-but-well-formed backup would restore cleanly.
test('undo: a tampered backup is refused, not restored', () => {
  const { gate, target, audit } = gateWith([AUTO], { config: { enabled: true, spend_per_tx_cap: 5 } });
  gate.apply('auto-surface', { enabled: false }, 'off');
  const row = audit.rows.at(-1);
  // well-formed, passes validate(), but not what we backed up
  writeFileSync(row.backup, JSON.stringify({ enabled: true, spend_per_tx_cap: 999999 }, null, 2));
  assert.throws(() => gate.undo(row.proposalId), /backup file has changed/);
  assert.equal(JSON.parse(readFileSync(target, 'utf-8')).spend_per_tx_cap, 5);
});

test('undo: a missing backup is a clear refusal, not a crash', () => {
  const { gate, audit } = gateWith([AUTO], { config: { enabled: true } });
  gate.apply('auto-surface', { enabled: false }, 'off');
  const row = audit.rows.at(-1);
  writeFileSync(row.backup, ''); // still there but now empty -> hash mismatch
  assert.throws(() => gate.undo(row.proposalId), /backup file has changed|does not validate/);
});

test('undo: an unknown proposal id is a 404, not a silent no-op', () => {
  const { gate } = gateWith([AUTO]);
  assert.throws(() => gate.undo('nope'), /no completed write with that id/);
});

test('undo: an action surface (no backup) points at the inverse action instead', () => {
  const { gate, audit } = gateWith([
    { id: 'act', title: 'Act', kind: 'action', schema: 'action:x', approval: 'auto' },
  ]);
  const g = new Gate({
    repoRoot: '/tmp', audit, backupDir: '/tmp/none',
    surfaces: [{ id: 'act', title: 'Act', target: '/tmp', schema: 'action:x', kind: 'action', approval: 'auto', tier: 1, secondChannel: null }],
    actions: { act: { describe: () => [{ path: 'j', from: 'running', to: 'paused' }], execute: () => 'j is now paused' } },
  });
  const out = g.submit('act', { action: 'pause', label: 'j' }, 'pause it');
  assert.equal(out.applied, true);
  const row = audit.rows.at(-1);
  assert.throws(() => g.undo(row.proposalId), /nothing to restore from|opposite action/);
});

// ---- diff rendering (bug-sweep pin, CHI-329) ----
// The write log and the confirm card both render `from -> to`. A cleared value
// arrives as `undefined`, and JSON.stringify(undefined) is undefined, so
// `{JSON.stringify(d.to)}` rendered NOTHING and the row read as if the change
// had no destination. Both call sites now fall back to 'unset'. Pinned as a
// source assertion because the bug is in the rendering expression itself.
test('every diff cell in the UI falls back to "unset" for an absent value', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/SafetyPage.tsx', 'src/gate/GateConfirmDialog.tsx']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8');
    for (const m of src.matchAll(/gate-diff-(from|to)">\{([^}]*)\}/g)) {
      assert.match(m[2], /\?\? 'unset'/, `${f}: gate-diff-${m[1]} must fall back to 'unset'`);
    }
  }
});

// JSX text does not process \u escapes: "→" in element text renders those
// six characters literally, not an arrow.
test('no literal \\uXXXX escape survives in rendered JSX text', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/SafetyPage.tsx', 'src/gate/GateConfirmDialog.tsx']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8');
    assert.doesNotMatch(src, />\\u[0-9a-fA-F]{4}</, `${f}: use the real character in JSX text`);
  }
});
