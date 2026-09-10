// Removal pin for pre-tool-use interception (issue #264, audit finding F1).
//
// Chronicle once scanned a tool call BEFORE the model saw it and recorded what
// it blocked: `preToolUseCheck()`, `listInterceptions()`, the `HIGH_SEVERITY`
// set and the `interceptions` table. They served a hook the shrink removed, so
// the alarm was wired to a door that is no longer there. Redaction — the half
// of `server/security.ts` an operator can still reach — stays, and is asserted
// here beside the removal so a sweep can never pass by deleting the module.
//
// Three things no source read can answer are asserted live, against a real
// temp data folder: the migration running over a folder an older Chronicle
// left behind, `security_rules` existing after `server/db.ts` alone is
// imported, and the rules CRUD still round-tripping through it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, tracked, BINARY } from './helpers/tracked-files.mjs';
import { readSource } from './helpers/read-source.mjs';

const read = (rel) => readSource(path.join(REPO, rel));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-intercept-'));
let security;
let dbModule;
let namesAfterDbAlone;

before(async () => {
  // A data folder written by a Chronicle that still had the feature: the table
  // and one recorded block in it.
  const seed = new DatabaseSync(path.join(dir, 'chronicle.db'));
  seed.exec(`
    CREATE TABLE interceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      tool_name TEXT, file_path TEXT, rules TEXT, sample TEXT, action TEXT
    );
    INSERT INTO interceptions (tool_name, file_path, rules, sample, action)
      VALUES ('Read', '/tmp/.env', '["API keys"]', 'sk-****', 'blocked');
  `);
  seed.close();
  process.env.CHRONICLE_DATA_DIR = dir;
  // Dynamic, and after CHRONICLE_DATA_DIR is set: server/db.ts opens
  // <dir>/chronicle.db at import time and runs the drops as it does.
  dbModule = await import('../server/db.ts');
  // Snapshotted BETWEEN the two imports: `server/db.ts` is meant to be the one
  // place a table is declared, and only a read taken before `server/security.ts`
  // has been touched can tell that apart from security.ts declaring its own.
  namesAfterDbAlone = objectNames();
  security = await import('../server/security.ts');
});

const objectNames = () =>
  dbModule.db.prepare('SELECT name FROM sqlite_master').all().map((r) => r.name);

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('the security module exports no interception machinery', () => {
  const gone = ['preToolUseCheck', 'listInterceptions'];
  const back = gone.filter((name) => name in security);
  assert.deepEqual(back, [], `server/security.ts exports again: ${back.join(', ')}`);
});

test('the security module declares no interception types or severity set', () => {
  // Types are erased before anything can import them and `HIGH_SEVERITY` was
  // module-private, so the source is the only place either can be seen at all.
  const src = read('server/security.ts');
  const declared = [...src.matchAll(/^(?:export )?(?:interface|type|const|function) (\w+)/gm)]
    .map((m) => m[1]);
  const back = declared.filter((name) => /Interception|PreToolUse|HIGH_SEVERITY/.test(name));
  assert.deepEqual(back, [], `server/security.ts still declares: ${back.join(', ')}`);
});

test('booting on an upgraded data folder drops the interceptions table', () => {
  const left = objectNames().filter((n) => /interception/i.test(n));
  assert.deepEqual(left, [], `an upgraded data folder still carries ${left.join(', ')}`);
});

test('the drop takes nothing else with it', () => {
  const names = objectNames();
  for (const t of ['projects', 'sessions', 'messages', 'security_rules']) {
    assert.ok(names.includes(t), `the migration removed ${t}`);
  }
});

test('server/db.ts is what creates the security_rules table', () => {
  assert.ok(
    namesAfterDbAlone.includes('security_rules'),
    'security_rules is missing until server/security.ts is imported',
  );
});

test('the security module executes no table DDL of its own', () => {
  const src = read('server/security.ts');
  const ddl = [...src.matchAll(/CREATE TABLE[^(]*/gi)].map((m) => m[0].trim());
  assert.deepEqual(ddl, [], `server/security.ts still declares schema: ${ddl.join(', ')}`);
});
