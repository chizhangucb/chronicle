// CHI-286: billed usage must be collapsed on Anthropic's per-API-call key.
//
// Claude Code splits ONE API response's content blocks across several transcript
// lines (an empty `thinking` block, then text, then tool_use), and every one of
// those lines repeats the full `message.usage`. The parser-side collapse is
// pinned in test/parsers/claudeCode.test.mjs; this file pins the DB side:
//
//  1. the one-time backfill that re-derives `sessions.usage` for history whose
//     transcript Claude Code has already pruned (the DB is the only record for
//     ~90% of it), and
//  2. the widened bug sweep — any surface that aggregates a billed magnitude
//     without a per-call identity key.
//
// The migration runs at MODULE LOAD, so the DB has to be seeded before
// server/db.ts is imported. node:test gives each test file its own process, so
// a dynamic import after seeding gets a clean module registry.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dbModule, dir, livePath;

// One usage-bearing message row. `seq` drives the ordering the collapse walks.
function msg(db, sessionId, seq, cells, kind = 'assistant') {
  db.prepare(`INSERT INTO messages (session_id, seq, kind, model, input_tokens, output_tokens,
                                    cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, seq, kind, cells.model, cells.input, cells.output, cells.cacheRead, cells.cw5m, cells.cw1h);
}

function session(db, id, usage, filePath) {
  db.prepare(`INSERT INTO sessions (id, project_id, source, file_path, started_at, ended_at,
                                    message_count, usage, imported_at, minor)
              VALUES (?, 1, 'claude-code', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 4, ?, '2026-08-02T00:00:00.000Z', 0)`)
    .run(id, filePath, usage === null ? null : JSON.stringify(usage));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-chi286-'));
  // A transcript that still exists on disk, so Lane 1 can target it.
  livePath = path.join(dir, 'live-session.jsonl');
  fs.writeFileSync(livePath, '');

  const seed = new DatabaseSync(path.join(dir, 'chronicle.db'));
  seed.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, source TEXT NOT NULL, file_path TEXT NOT NULL,
                           started_at TEXT, ended_at TEXT, message_count INTEGER DEFAULT 0, first_prompt TEXT,
                           usage TEXT, imported_at TEXT, minor INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
                           uuid TEXT, ts TEXT, kind TEXT NOT NULL, text TEXT, tool_name TEXT, tool_input TEXT,
                           tool_use_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
                           cache_read_tokens INTEGER, cache_w5m_tokens INTEGER, cache_w1h_tokens INTEGER);
    INSERT INTO projects (id, path, name) VALUES (1, '/tmp/p', 'p');
    -- CHI-223: a database written by an older Chronicle carries the retired
    -- contract views and the version pragma that gated them. Seed both so the
    -- test below proves opening it clears them.
    CREATE VIEW contract_sessions AS SELECT id FROM sessions;
    CREATE VIEW contract_message_metrics AS SELECT session_id FROM messages;
    PRAGMA user_version = 1;
  `);

  const dup = { model: 'm', input: 10, output: 100, cacheRead: 5000, cw5m: 0, cw1h: 700 };
  const other = { model: 'm', input: 10, output: 250, cacheRead: 5800, cw5m: 0, cw1h: 120 };

  // (a) The real shape: two API calls, the first written to two adjacent rows
  //     with identical cells. Pre-fix `usage` therefore double-counts call one.
  session(seed, 'dup', { m: { input: 30, output: 450, cacheWrite5m: 0, cacheWrite1h: 1520, cacheRead: 15800 } }, path.join(dir, 'gone.jsonl'));
  msg(seed, 'dup', 0, dup);
  msg(seed, 'dup', 1, dup);            // replay of the same call
  msg(seed, 'dup', 2, other);

  // (b) Adjacent all-zero rows must NOT collapse: they cannot be shown to be a
  //     replay, and the only false positive found across every transcript on
  //     disk was exactly this shape (a pair of `<synthetic>` rows).
  session(seed, 'zeros', { '<synthetic>': { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }, path.join(dir, 'gone2.jsonl'));
  msg(seed, 'zeros', 0, { model: '<synthetic>', input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
  msg(seed, 'zeros', 1, { model: '<synthetic>', input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });

  // (c) No per-message token rows at all (an import predating those columns):
  //     nothing to re-derive from, so the inflated value must STAND and be
  //     labelled, never silently zeroed.
  session(seed, 'bare', { m: { input: 99, output: 99, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }, path.join(dir, 'gone3.jsonl'));
  msg(seed, 'bare', 0, { model: 'm', input: null, output: null, cacheRead: null, cw5m: null, cw1h: null }, 'user');

  // (d) Message rows sum to MORE than the stored blob — an assumption broke, so
  //     the migration must refuse rather than rewrite upward.
  session(seed, 'upward', { m: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }, path.join(dir, 'gone4.jsonl'));
  msg(seed, 'upward', 0, { model: 'm', input: 500, output: 500, cacheRead: 0, cw5m: 0, cw1h: 0 });

  // (e) Transcript still on disk → Lane 1 queues it for an exact re-import.
  session(seed, 'live', { m: { input: 20, output: 200, cacheWrite5m: 0, cacheWrite1h: 1400, cacheRead: 10000 } }, livePath);
  msg(seed, 'live', 0, dup);
  msg(seed, 'live', 1, dup);
  seed.close();

  process.env.CHRONICLE_DATA_DIR = dir;
  dbModule = await import('../server/db.ts'); // migration runs here
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (id) => dbModule.db.prepare('SELECT usage, usage_source, imported_at FROM sessions WHERE id = ?').get(id);

describe('CHI-286 backfill', () => {
  test('collapses an adjacent replayed row and rebuilds sessions.usage from the survivors', () => {
    const r = row('dup');
    assert.equal(r.usage_source, 'rederived');
    // Call one counted once (10/100/5000/700) plus call two (10/250/5800/120).
    assert.deepEqual(JSON.parse(r.usage), {
      m: { input: 20, output: 350, cacheWrite5m: 0, cacheWrite1h: 820, cacheRead: 10800 },
    });
  });

  test('clears the token columns of the dropped row so message sums stop double-counting', () => {
    const rows = dbModule.db.prepare(
      'SELECT seq, input_tokens FROM messages WHERE session_id = ? ORDER BY seq').all('dup');
    // NULL, not 0 — that keeps "dropped as a replay" distinguishable from
    // "genuinely billed zero" on any later pass. Readers all COALESCE.
    assert.deepEqual(rows.map((x) => x.input_tokens), [10, null, 10]);
    // And the message rows now sum to the same figure as sessions.usage.
    const summed = dbModule.db.prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
         FROM messages WHERE session_id = ?`).get('dup');
    const usage = JSON.parse(row('dup').usage).m;
    assert.equal(summed.input, usage.input);
    assert.equal(summed.output, usage.output);
  });

  test('does NOT collapse adjacent all-zero rows (the one observed false-positive shape)', () => {
    const rows = dbModule.db.prepare(
      'SELECT input_tokens FROM messages WHERE session_id = ? ORDER BY seq').all('zeros');
    assert.deepEqual(rows.map((x) => x.input_tokens), [0, 0]);
  });

  test('leaves usage untouched and labels it when there is nothing to re-derive from', () => {
    const r = row('bare');
    assert.equal(r.usage_source, 'unverified');
    assert.deepEqual(JSON.parse(r.usage), { m: { input: 99, output: 99, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  });

  test('never rewrites upward', () => {
    const r = row('upward');
    assert.equal(r.usage_source, 'unverified');
    assert.deepEqual(JSON.parse(r.usage), { m: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  });

  test('queues sessions whose transcript still exists for an exact re-import', () => {
    // imported_at NULL is what makes autosync re-parse: its skip test is
    // `mtime <= importedAtMs(imported_at)`, and importedAtMs(null) === 0.
    assert.equal(row('live').imported_at, null);
    // A pruned session has no file to re-read, so it keeps its stamp.
    assert.notEqual(row('dup').imported_at, null);
  });

  test('is gated on an explicit marker, not on a data shape a re-import would reset', () => {
    const marker = dbModule.db.prepare(
      'SELECT name FROM chronicle_migrations WHERE name = ?').get('chi-286-collapse-replayed-usage');
    assert.ok(marker, 'migration marker row must exist');
    // replaceSession rewrites usage_source on every import, so gating on
    // "usage_source IS NULL" would re-run this migration on every boot, forever.
  });
});

// CHI-223: the contract views are retired. The base tables are the only read
// seam, and an older database that still holds the views loses them on open.
describe('CHI-223 contract views', () => {
  test('opening an existing database leaves no contract_* view behind', () => {
    const views = dbModule.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view'").all().map((r) => r.name);
    assert.deepEqual(views.filter((n) => n.startsWith('contract_')), []);
  });
});

// ── Widened bug sweep (CLAUDE.md standing rule) ──────────────────────────────
// The pattern class is "aggregate a billed magnitude without a per-call identity
// key", not just "the Claude Code parser". The other billed surface is the
// machine-session manifest, which feeds the Spend tile's automation bucket.
describe('CHI-286 sweep: machine-session manifest', () => {
  test('readMachineSessions never counts one session_id twice', async () => {
    const { readMachineSessions } = await import('../server/machineSessions.ts');
    const manifest = path.join(dir, 'machine_sessions.jsonl');
    const line = (id, ts) => JSON.stringify({
      session_id: id, job: 'weekly', ts, model: 'sonnet',
      usage: { input_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 3, output_tokens: 4 },
    });
    // The manifest is append-only, so a re-spawned job can write the same
    // session_id twice. Unguarded that double-bills automation spend.
    fs.writeFileSync(manifest, [
      line('s1', '2026-08-01T00:00:00Z'),
      line('s1', '2026-08-01T00:05:00Z'),
      line('s2', '2026-08-01T00:10:00Z'),
    ].join('\n') + '\n');
    const result = readMachineSessions(null, manifest);
    assert.equal(new Set(result.ids).size, result.ids.length, 'ids must be distinct');
    assert.equal(result.ids.length, 2);
  });
});
