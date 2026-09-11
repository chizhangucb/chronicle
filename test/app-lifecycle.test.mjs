// The seam ticket #275 asks for: nothing happens when a server module is
// imported, and both the database and the app are opened by an explicit call.
// Every assertion here is about the lifecycle itself, so the file sets
// CHRONICLE_DATA_DIR before it imports anything of Chronicle's (server/config.ts
// freezes the folder at import) and disables auto-sync in that folder, so the
// standalone entry can be started without spawning watchers over the real
// ~/.claude tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-lifecycle-home-'));
process.env.CHRONICLE_DATA_DIR = homeDir;
fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ autoSync: false }));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-lifecycle-'));
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('importing server/db.ts opens no database and writes no file', async () => {
  const before = fs.readdirSync(homeDir);
  const dbModule = await import('../server/db.ts');
  assert.equal(typeof dbModule.openDatabase, 'function', 'db.ts must expose openDatabase()');
  assert.deepEqual(fs.readdirSync(homeDir), before, 'importing db.ts must not touch the data folder');
});

test('importing server/api.ts starts no autosync', async () => {
  const apiModule = await import('../server/api.ts');
  assert.equal(typeof apiModule.createApp, 'function', 'api.ts must expose createApp()');
  assert.equal(globalThis.__chronicleAutoSync, undefined, 'importing api.ts must not start auto-sync');
});

test('openDatabase(dir) opens the database in that dir and applies the schema', async () => {
  const { openDatabase, closeDatabase, getDb } = await import('../server/db.ts');
  const dir = tempDir();
  const db = openDatabase(dir);
  assert.ok(fs.existsSync(path.join(dir, 'chronicle.db')), 'openDatabase must open <dir>/chronicle.db');
  const tables = tableNames(db);
  for (const t of ['projects', 'sessions', 'messages', 'session_tombstones', 'security_rules', 'chronicle_migrations']) {
    assert.ok(tables.includes(t), `schema must create ${t}`);
  }
  // Migrations ran: a column added by one of the idempotent ALTERs is present.
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  for (const c of ['usage', 'agent_active_ms', 'result_count', 'usage_source']) {
    assert.ok(cols.includes(c), `migrations must add sessions.${c}`);
  }
  // Backfills ran: the one-shot ledger is marked on a fresh database.
  const done = db.prepare('SELECT COUNT(*) AS c FROM chronicle_migrations').get().c;
  assert.ok(done > 0, 'openDatabase must run the backfills, which stamp the migration ledger');
  // Closing it releases the folder: opening it again is a live handle, not the
  // closed one.
  closeDatabase(db);
  const reopened = openDatabase(dir);
  assert.notEqual(reopened, db, 'a closed database must not be handed back');
  assert.equal(reopened.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  assert.equal(getDb(), reopened);
});

test('createApp(openDatabase(dir)) serves the API against that database', async () => {
  const { openDatabase, upsertProject } = await import('../server/db.ts');
  const { createApp } = await import('../server/api.ts');
  const app = createApp(openDatabase(tempDir()));
  upsertProject('/tmp/lifecycle-proj');
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.some((p) => p.path === '/tmp/lifecycle-proj'), 'the app must read the database it was given');
  } finally {
    await close();
  }
});

test('table schema lives in one module', async () => {
  const { tracked, read } = await import('./helpers/tracked-files.mjs');
  const offenders = tracked
    .filter((f) => (f.startsWith('server/') || f.startsWith('scripts/')) && f.endsWith('.ts'))
    .filter((f) => f !== 'server/schema.ts')
    .filter((f) => /CREATE\s+(VIRTUAL\s+)?TABLE/i.test(read(f)));
  assert.deepEqual(offenders, [], 'CREATE TABLE belongs in server/schema.ts only');
});

test('the standalone entry opens the database and builds the app itself', async () => {
  const { startServer } = await import('../server/standalone.ts');
  const server = await startServer(0, tempDir());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`);
    assert.equal(res.status, 200, 'the production entry must serve a live API');
    assert.ok(Array.isArray(await res.json()));
    assert.ok(fs.existsSync(path.join(homeDir, 'chronicle.db')), 'the production entry must open the real data folder');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the demo entry opens its own database and imports through it', async () => {
  // Demo is the other production entry: the CLI seeds before it starts a
  // server, so seedDemo has to open the database it writes into.
  const dir = tempDir();
  process.env.CHRONICLE_DATA_DIR = dir;
  try {
    const { seedDemo } = await import('../server/demo/seed.ts');
    const { seeded } = await seedDemo(dir);
    assert.ok(seeded > 0, 'seedDemo must import demo sessions');
    const { openDatabase } = await import('../server/db.ts');
    const rows = openDatabase(dir).prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
    assert.equal(rows, seeded, 'the seeded sessions must land in the demo database');
  } finally {
    process.env.CHRONICLE_DATA_DIR = homeDir;
  }
});

test('createApp refuses a database the lifecycle never opened', async () => {
  // A foreign handle would read as FTS-less and would have no folder to snapshot
  // into before a delete, so the app says no rather than serving it half-blind.
  const { DatabaseSync } = await import('node:sqlite');
  const { createApp } = await import('../server/api.ts');
  const stray = new DatabaseSync(path.join(tempDir(), 'stray.db'));
  try {
    assert.throws(() => createApp(stray), /openDatabase/);
  } finally {
    stray.close();
  }
});
