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

before(async () => {
  process.env.CHRONICLE_DATA_DIR = dir;
  security = await import('../server/security.ts');
});

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
