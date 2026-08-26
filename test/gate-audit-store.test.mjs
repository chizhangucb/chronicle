// Pins the gate_audit SQLite store (CHI-323 D5): the audit trail is a
// self-created table, not Varde's JSON file. Set CHRONICLE_DATA_DIR to a temp
// dir BEFORE import so the DB (and the table) land there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CHRONICLE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gate-audit-'));
const { sqliteAuditStore } = await import('../server/gate/audit-store.ts');

test('append + read roundtrip through the gate_audit table, newest N chronologically', () => {
  const store = sqliteAuditStore();
  const mk = (i, event) => ({
    ts: `2026-08-25T00:00:0${i}Z`, event, surface: 'hub-spend-caps', proposalId: `p${i}`,
    actor: 'operator', reason: `r${i}`, diff: [{ path: 'spend_per_tx_cap', from: i, to: i + 1 }],
  });
  store.append(mk(1, 'proposed'));
  store.append(mk(2, 'confirmed'));
  const rows = store.read(10);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.event), ['proposed', 'confirmed']); // chronological
  assert.deepEqual(rows[0].diff, [{ path: 'spend_per_tx_cap', from: 1, to: 2 }]);
  assert.equal(rows[1].reason, 'r2');
});

test('optional fields (backup, error, detail) roundtrip; read(limit) returns the newest N', () => {
  const store = sqliteAuditStore();
  store.append({ ts: 't', event: 'failed', surface: 's', proposalId: 'x', actor: 'a', reason: 'r', diff: [], error: 'boom' });
  store.append({ ts: 't', event: 'allowed', surface: '/api/launch', proposalId: '', actor: 'dashboard', reason: 'r', diff: [], detail: { status: 200 } });
  const last = store.read(1);
  assert.equal(last.length, 1);
  assert.equal(last[0].event, 'allowed');
  assert.deepEqual(last[0].detail, { status: 200 });
  const withErr = store.read(50).find((r) => r.event === 'failed');
  assert.equal(withErr.error, 'boom');
});
