// CHI-324 2h / B1: the records() hub slice (server/hub/slices/records.ts),
// ported from Varde. Parses records/sessions.jsonl + decisions.jsonl, index
// fields only (never the decision body), newest-first, tolerant of torn lines.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let records, hub;

before(async () => {
  records = await import('../server/hub/slices/records.ts');
  hub = mkdtempSync(join(tmpdir(), 'records-hub-'));
  mkdirSync(join(hub, 'records'), { recursive: true });
});
after(() => rmSync(hub, { recursive: true, force: true }));

test('parseLedgerRows: newest-first by stamp, drops rows without a session, tolerates a torn line', () => {
  const text = [
    '{"stamp":"2026-08-24 0900","session":"aaa","focus":"early","repo":"hub"}',
    '{"stamp":"2026-08-26 0930","session":"ccc","focus":"latest","repo":"chronicle"}',
    '{"stamp":"2026-08-25 1200","focus":"no session id"}',            // no session → dropped
    '{"stamp":"2026-08-25 1610","session":"bbb","focus":"mid"}',       // no repo → repo:null
    '{"stamp":"2026-08-27 0000","session":"ddd","focus":"torn"',       // torn trailing → skipped
  ].join('\n');
  const rows = records.parseLedgerRows(text);
  assert.deepEqual(rows.map((r) => r.sessionId), ['ccc', 'bbb', 'aaa']); // newest-first, no-session dropped
  assert.equal(rows.find((r) => r.sessionId === 'bbb').repo, null);
});

test('parseDecisionRows: keeps file order, reads date+title only (never the body)', () => {
  const text = [
    '{"date":"2026-08-24","title":"first","session":"s1","body":"the confidential why"}',
    '{"title":"undated","body":"more why"}',
  ].join('\n');
  const rows = records.parseDecisionRows(text);
  assert.deepEqual(rows, [{ date: '2026-08-24', title: 'first' }, { date: null, title: 'undated' }]);
  // no `body`/`session`/`stream` field leaks through
  assert.ok(rows.every((r) => Object.keys(r).sort().join() === 'date,title'));
});

test('collectRecords: reads both files, decisions newest-first, found=true; missing files → found=false', () => {
  writeFileSync(join(hub, 'records', 'sessions.jsonl'),
    '{"stamp":"2026-08-26 0930","session":"ccc","focus":"latest","repo":"chronicle"}\n');
  writeFileSync(join(hub, 'records', 'decisions.jsonl'),
    ['{"date":"2026-08-20","title":"older"}', '{"date":"2026-08-25","title":"newer"}'].join('\n') + '\n');
  const slice = records.collectRecords(hub);
  assert.equal(slice.found, true);
  assert.equal(slice.ledger.total, 1);
  assert.equal(slice.ledger.rows[0].sessionId, 'ccc');
  assert.equal(slice.decisions.total, 2);
  assert.equal(slice.decisions.recent[0].title, 'newer'); // file is oldest-first, peek is newest-first

  const empty = records.collectRecords(join(hub, 'nope'));
  assert.equal(empty.found, false);
  assert.equal(empty.ledger.total, 0);
});
