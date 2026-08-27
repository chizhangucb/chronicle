// CHI-351 /ask core: the SELECT-only guard, result caps, the answer envelope,
// bounded history, and the deduped cost views (session_model_cost /
// message_cost) that must reconcile with the dashboards. No claude binary or
// real db needed — the guard is exercised directly and the views over a
// synthetic in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeAskSql, stripSqlComments, wrapLimited, shapeRows,
  validateAskEnvelope, normalizeAskCostMode, toCostMode, costBasisLabel,
  parseHistory, appendAskTurn, readAskHistory, ASK_HISTORY_MAX, ASK_HISTORY_ROWS, ASK_MAX_ROWS,
  pickCapture, askClaudeArgs,
} from '../server/ask.ts';
import { buildCostSurface } from '../server/askDb.ts';

// ---- SELECT-only guard ---------------------------------------------------
test('sanitizeAskSql: accepts SELECT and WITH', () => {
  assert.equal(sanitizeAskSql('SELECT 1').ok, true);
  assert.equal(sanitizeAskSql('  select * from sessions  ').ok, true);
  assert.equal(sanitizeAskSql('WITH t AS (SELECT 1) SELECT * FROM t').ok, true);
  assert.equal(sanitizeAskSql('SELECT 1;').ok, true); // single trailing ;
});

test('sanitizeAskSql: rejects writes / DDL / PRAGMA / ATTACH', () => {
  for (const bad of [
    'INSERT INTO sessions VALUES (1)', 'UPDATE sessions SET id=1', 'DELETE FROM sessions',
    'DROP TABLE sessions', 'CREATE TABLE x(a)', 'ATTACH DATABASE \'/tmp/x\' AS y',
    'PRAGMA writable_schema=ON', 'VACUUM',
  ]) {
    assert.equal(sanitizeAskSql(bad).ok, false, `should reject: ${bad}`);
  }
});

test('sanitizeAskSql: rejects a smuggled second statement', () => {
  assert.equal(sanitizeAskSql('SELECT 1; DROP TABLE sessions').ok, false);
  assert.equal(sanitizeAskSql('SELECT 1; SELECT 2').ok, false);
});

test('sanitizeAskSql: a leading comment cannot smuggle a non-SELECT', () => {
  assert.equal(sanitizeAskSql('/* hi */ DELETE FROM sessions').ok, false);
  assert.equal(sanitizeAskSql('-- comment\nSELECT 1').ok, true);
  assert.equal(stripSqlComments('/* a */ -- b\n SELECT 1'), 'SELECT 1');
});

test('sanitizeAskSql: rejects load_extension', () => {
  assert.equal(sanitizeAskSql("SELECT load_extension('/x.so')").ok, false);
});

test('sanitizeAskSql: string-literal aware — a ; or -- inside a string is fine', () => {
  // These are single valid SELECTs; the ";" / "--" live inside string literals.
  const a = sanitizeAskSql("SELECT * FROM messages WHERE text LIKE '%foo; bar%'");
  assert.equal(a.ok, true);
  assert.equal(a.sql, "SELECT * FROM messages WHERE text LIKE '%foo; bar%'");
  const b = sanitizeAskSql("SELECT '-- not a comment' AS a");
  assert.equal(b.ok, true);
  assert.equal(b.sql, "SELECT '-- not a comment' AS a"); // literal preserved, not stripped
  const c = sanitizeAskSql("SELECT '/* keep */' AS a");
  assert.equal(c.ok, true);
  assert.equal(c.sql, "SELECT '/* keep */' AS a");
  // An escaped quote ('') inside a string does not end it.
  assert.equal(sanitizeAskSql("SELECT 'it''s; fine' AS a").ok, true);
  // A real trailing statement is still rejected.
  assert.equal(sanitizeAskSql("SELECT '%a%'; DROP TABLE sessions").ok, false);
});

test('sanitizeAskSql: rejects empty / non-string', () => {
  assert.equal(sanitizeAskSql('').ok, false);
  assert.equal(sanitizeAskSql('   ').ok, false);
  assert.equal(sanitizeAskSql(null).ok, false);
  assert.equal(sanitizeAskSql('/* only a comment */').ok, false);
});

test('wrapLimited caps rows at the SQL layer', () => {
  assert.match(wrapLimited('SELECT 1'), new RegExp(`LIMIT ${ASK_MAX_ROWS + 1}`));
});

// ---- result shaping / caps ------------------------------------------------
test('shapeRows: caps rows and flags truncation', () => {
  const rows = Array.from({ length: ASK_MAX_ROWS + 1 }, (_, i) => ({ a: i }));
  const r = shapeRows(rows, true);
  assert.equal(r.rowCount, ASK_MAX_ROWS);
  assert.equal(r.rows.length, ASK_MAX_ROWS);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.columns, ['a']);
});

test('shapeRows: truncates a huge cell and coerces bigint', () => {
  const big = 'x'.repeat(5000);
  const r = shapeRows([{ a: big, b: 10n }], false);
  assert.ok(r.rows[0][0].length < 5000 && r.rows[0][0].endsWith('...'));
  assert.equal(r.rows[0][1], 10);
});

test('shapeRows: empty result has no columns', () => {
  const r = shapeRows([], false);
  assert.deepEqual(r, { columns: [], rows: [], rowCount: 0, truncated: false });
});

// ---- envelope -------------------------------------------------------------
test('validateAskEnvelope: valid + normalizes costBasis + optional note', () => {
  const e = validateAskEnvelope({ prose: ' hi ', sql: 'SELECT 1', costBasis: 'real', note: ' n ' });
  assert.equal(e.prose, 'hi');
  assert.equal(e.sql, 'SELECT 1');
  assert.equal(e.costBasis, 'billed');
  assert.equal(e.note, 'n');
  assert.equal(validateAskEnvelope({ prose: 'p', sql: 's' }).costBasis, 'list');
});

test('validateAskEnvelope: rejects missing prose/sql or non-object', () => {
  assert.throws(() => validateAskEnvelope({ sql: 'SELECT 1' }));
  assert.throws(() => validateAskEnvelope({ prose: 'p' }));
  assert.throws(() => validateAskEnvelope('nope'));
  assert.throws(() => validateAskEnvelope(null));
});

test('cost-basis helpers', () => {
  assert.equal(normalizeAskCostMode('billed'), 'billed');
  assert.equal(normalizeAskCostMode('real'), 'billed');
  assert.equal(normalizeAskCostMode('anything'), 'list');
  assert.equal(toCostMode('billed'), 'real');
  assert.equal(toCostMode('list'), 'theoretical');
  assert.equal(costBasisLabel('billed'), 'Billed');
  assert.equal(costBasisLabel('list'), 'List price');
});

// ---- runner helpers: pickCapture + confinement pin ------------------------
test('pickCapture: matches declared sql, else last, null on empty/none', () => {
  const caps = [
    { sql: 'SELECT a FROM x', columns: ['a'], rows: [[1]], rowCount: 1, truncated: false },
    { sql: 'SELECT b FROM y', columns: ['b'], rows: [[2]], rowCount: 1, truncated: false },
  ];
  assert.equal(pickCapture(caps, 'SELECT a FROM x').columns[0], 'a'); // exact match (not last)
  assert.equal(pickCapture(caps, 'select A  from  x').columns[0], 'a'); // normalized match
  assert.equal(pickCapture(caps, 'SELECT z FROM nope').columns[0], 'b'); // no match -> last
  assert.equal(pickCapture(caps, ''), null); // model couldn't answer -> no spurious table
  assert.equal(pickCapture(caps, '   '), null);
  assert.equal(pickCapture([], 'SELECT 1'), null); // no captures
});

test('askClaudeArgs pins the one-tool confinement (STANDING RULE)', () => {
  const args = askClaudeArgs('PROMPT', '/cfg.json');
  // --tools "" disables ALL built-ins; without it the model regains Bash/Read.
  const ti = args.indexOf('--tools');
  assert.ok(ti >= 0 && args[ti + 1] === '');
  assert.ok(args.includes('--strict-mcp-config'));
  const ai = args.indexOf('--allowedTools');
  assert.equal(args[ai + 1], 'mcp__chronicledb__query'); // exactly the one tool
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(0, 2), ['-p', 'PROMPT']);
  assert.ok(askClaudeArgs('P', '/c', 'claude-opus-5').includes('claude-opus-5'));
});

// ---- history --------------------------------------------------------------
test('parseHistory: skips malformed lines, keeps well-formed turns', () => {
  const turns = parseHistory('{"id":"a","question":"q"}\ngarbage\n\n{"id":"b","question":"q2"}');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.id), ['a', 'b']);
});

test('appendAskTurn: persists and prunes to ASK_HISTORY_MAX', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-hist-'));
  const env = { CHRONICLE_DATA_DIR: dir };
  try {
    for (let i = 0; i < ASK_HISTORY_MAX + 25; i++) {
      appendAskTurn({ id: `t${i}`, ts: '', question: `q${i}`, costBasis: 'list', ok: true, prose: 'p', sql: null, columns: [], rows: [], rowCount: 0, truncated: false }, env);
    }
    const kept = readAskHistory(env);
    assert.equal(kept.length, ASK_HISTORY_MAX);
    assert.equal(kept[kept.length - 1].id, `t${ASK_HISTORY_MAX + 24}`); // newest last
    assert.equal(kept[0].id, 't25'); // oldest pruned
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendAskTurn: caps stored rows per turn to bound file size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-hist2-'));
  const env = { CHRONICLE_DATA_DIR: dir };
  try {
    const rows = Array.from({ length: 300 }, (_, i) => [i]);
    appendAskTurn({ id: 'big', ts: '', question: 'q', costBasis: 'list', ok: true, prose: 'p',
      sql: 'SELECT 1', columns: ['a'], rows, rowCount: 300, truncated: false }, env);
    const [t] = readAskHistory(env);
    assert.equal(t.rows.length, ASK_HISTORY_ROWS);
    assert.equal(t.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the read-only handle is the real SELECT-only wall --------------------
test('a read-only DatabaseSync rejects writes (the actual guarantee)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-ro-'));
  const p = join(dir, 'w.db');
  try {
    const w = new DatabaseSync(p);
    w.exec('CREATE TABLE t(a); INSERT INTO t VALUES (1)');
    w.close();
    const ro = new DatabaseSync(p, { readOnly: true });
    assert.throws(() => ro.exec('INSERT INTO t VALUES (2)'));
    assert.throws(() => ro.exec("ATTACH DATABASE '/tmp/x.db' AS y"));
    assert.equal(ro.prepare('SELECT COUNT(*) c FROM t').get().c, 1); // reads still work
    ro.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- deduped cost views (honesty-critical) --------------------------------
function synthDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY, path TEXT, name TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id INTEGER, source TEXT, started_at TEXT,
      ended_at TEXT, usage TEXT, usage_source TEXT);
    CREATE TABLE messages(session_id TEXT, seq INTEGER, ts TEXT, kind TEXT, model TEXT, tool_name TEXT,
      skill TEXT, is_sidechain INTEGER, agent_type TEXT, agent_id TEXT, workflow_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_w5m_tokens INTEGER, cache_w1h_tokens INTEGER);
    INSERT INTO projects VALUES (1, '/p/varde', 'varde');
    INSERT INTO sessions VALUES ('s1', 1, 'claude-code', '2026-07-10T00:00:00Z', '2026-07-10T01:00:00Z',
      '{"claude-opus-4-8":{"input":1000000,"output":200000,"cacheRead":100000}}', 'exact');
    INSERT INTO messages VALUES ('s1', 0, '2026-07-10T00:00:00Z', 'assistant', 'claude-opus-4-8', NULL, NULL,
      1, 'code-reviewer', 'a1', NULL, 1000000, 200000, 100000, 0, 0);
  `);
  return d;
}

test('buildCostSurface: session_model_cost prices the deduped sessions.usage (list)', () => {
  const d = synthDb();
  const res = buildCostSurface(d, 'theoretical', '2026-07-10');
  assert.equal(res.sessionView, true);
  assert.equal(res.messageView, true);
  assert.ok(res.pricingRows >= 1);
  // opus-4-8 list: input $5, output $25, cacheRead $0.5 per MTok.
  // 1M*5 + 0.2M*25 + 0.1M*0.5 = 5 + 5 + 0.05 = 10.05
  const row = d.prepare(`SELECT project_path, model, ROUND(cost_usd,2) AS c FROM session_model_cost`).get();
  assert.equal(row.project_path, '/p/varde');
  assert.equal(row.model, 'claude-opus-4-8');
  assert.equal(row.c, 10.05);
});

test('buildCostSurface: Billed zeroes subscription-covered models', () => {
  const d = synthDb();
  buildCostSurface(d, 'real', '2026-07-10');
  const row = d.prepare(`SELECT cost_usd AS c FROM session_model_cost`).get();
  assert.equal(row.c, 0); // opus is subscription-covered -> $0 billed
});

test('buildCostSurface: message_cost supports subagent (is_sidechain) cuts', () => {
  const d = synthDb();
  buildCostSurface(d, 'theoretical', '2026-07-10');
  const row = d.prepare(`SELECT agent_type, ROUND(SUM(cost_usd),2) AS c FROM message_cost
                         WHERE is_sidechain=1 GROUP BY agent_type`).get();
  assert.equal(row.agent_type, 'code-reviewer');
  assert.equal(row.c, 10.05); // same tokens, same price -> reconciles with session view
});

test('buildCostSurface: unpriced model is visible (priced=0, cost NULL), not silently $0', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY, path TEXT, name TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id INTEGER, source TEXT, started_at TEXT,
      ended_at TEXT, usage TEXT, usage_source TEXT);
    CREATE TABLE messages(session_id TEXT, seq INTEGER, ts TEXT, kind TEXT, model TEXT, tool_name TEXT,
      skill TEXT, is_sidechain INTEGER, agent_type TEXT, agent_id TEXT, workflow_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_w5m_tokens INTEGER, cache_w1h_tokens INTEGER);
    INSERT INTO projects VALUES (1, '/p/x', 'x');
    INSERT INTO sessions VALUES ('s1', 1, 'other', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z',
      '{"some-unknown-model":{"input":1000000,"output":0}}', NULL);
  `);
  buildCostSurface(d, 'theoretical', '2026-08-01');
  const row = d.prepare(`SELECT cost_usd, priced FROM session_model_cost`).get();
  assert.equal(row.priced, 0);        // flagged, not hidden
  assert.equal(row.cost_usd, null);   // NULL, not a misleading 0
});

test('buildCostSurface: windowed model priced at its OWN day, not the run day (reconciles)', () => {
  // Sonnet 5 intro window ends 2026-08-31 ($2/$10), then $3/$15. A session INSIDE
  // the window must price at $2 even when the run happens AFTER the window — this
  // is the fix that keeps /ask matching the dashboards (which price per session-day).
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY, path TEXT, name TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id INTEGER, source TEXT, started_at TEXT,
      ended_at TEXT, usage TEXT, usage_source TEXT);
    CREATE TABLE messages(session_id TEXT, seq INTEGER, ts TEXT, kind TEXT, model TEXT, tool_name TEXT,
      skill TEXT, is_sidechain INTEGER, agent_type TEXT, agent_id TEXT, workflow_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_w5m_tokens INTEGER, cache_w1h_tokens INTEGER);
    INSERT INTO projects VALUES (1, '/p/x', 'x');
    INSERT INTO sessions VALUES ('s1', 1, 'claude-code', '2026-08-15T00:00:00Z', '2026-08-15T01:00:00Z',
      '{"claude-sonnet-5":{"input":1000000,"output":0}}', 'exact');
  `);
  buildCostSurface(d, 'theoretical', '2026-09-15'); // run AFTER the window closed
  const row = d.prepare(`SELECT ROUND(cost_usd,4) AS c FROM session_model_cost`).get();
  assert.equal(row.c, 2); // 1M * $2 intro rate, NOT $3 post-window
});
