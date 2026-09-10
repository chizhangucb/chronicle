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

// Every spelling the feature ever had: the table and the prose (`intercept`,
// word-anchored, so `interceptions`, `interception` and `Interception records`
// are all one arm), the hook it served (`preToolUse`, `pre-tool-use`), and the
// severity set that decided what it blocked. `HIGH_SEVERITY` is
// case-SENSITIVE — it is an identifier, not a word an operator reads.
const SPELLINGS = [/\bintercept/i, /pre[-_ ]?tool[-_ ]?use/i, /HIGH_SEVERITY/];
const namesTheFeature = (text) => SPELLINGS.some((re) => re.test(text));

// Files allowed to name it, each for a reason that is not the feature living
// on. CHANGELOG.md is history and the audit is the record that found this dead
// code, same exemption shape as the vocabulary sweep in repo-shape; this file
// is the pin, so it has to spell what it forbids; server/db.ts carries the
// drop, which cannot drop a table without naming it, and is swept on its own
// terms by the test below instead.
const PIN_EXEMPT = new Set([
  'CHANGELOG.md',
  'docs/agents/design-audit-2026-09-04.md',
  'test/interceptions-removed.test.mjs',
  'server/db.ts',
]);

test('no tracked file carries an interception string, key or identifier', () => {
  // This is what stands in for the locale dictionaries the ticket names: the
  // `Interception records` keys went with the zh and ja dictionaries (#295),
  // and this sweep is what keeps them from coming back with a dictionary.
  assert.ok(tracked.length > 100, `expected a populated tracked file list, got ${tracked.length}`);
  const offenders = tracked.filter((rel) => {
    // Lockfiles everywhere, not just the root one: website/ ships its own.
    if (PIN_EXEMPT.has(rel) || BINARY.test(rel) || rel.endsWith('package-lock.json')) return false;
    return namesTheFeature(read(rel));
  });
  assert.deepEqual(offenders, [], `these tracked files still name the feature: ${offenders.join(', ')}`);
});

test('server/db.ts names the feature only where it drops it', () => {
  const lines = read('server/db.ts').split('\n');
  const at = lines.findIndex((l) => l.includes("DROP TABLE IF EXISTS interceptions"));
  assert.ok(at > 0, 'server/db.ts no longer drops the interceptions table');
  // The drop plus the contiguous comment above it: the retirement block, and
  // the only place in this module the word may appear.
  const block = new Set([at]);
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('//'); i--) block.add(i);
  const stray = lines
    .map((line, i) => [i, line])
    .filter(([i, line]) => !block.has(i) && namesTheFeature(line))
    .map(([i]) => i + 1);
  assert.deepEqual(stray, [], `server/db.ts names the feature outside its drop, at line(s) ${stray.join(', ')}`);
});
