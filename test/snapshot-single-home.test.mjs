// The read-only SQLite snapshot has one home (issue #380).
//
// Cursor and OpenCode are the two store-backed sources: many sessions in one
// SQLite file the running editor may still be writing. Both used to carry a
// verbatim copy of the same helper, so the read-only guarantee had two homes
// and could be fixed in one of them. The helper now lives in
// server/parsers/source.ts beside the other cross-parser helpers, and both
// parsers call it.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openSnapshot } from '../server/parsers/source.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scratch = [];
function makeScratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-snapshot-test-'));
  scratch.push(dir);
  return dir;
}

// A WAL-mode store with a row that has not been checkpointed, which is what a
// store its editor still holds open looks like: the writer stays open, so the
// row lives in the `-wal` sidecar rather than in the `.db` file.
const writers = [];
function makeLiveStore(dir, name = 'live.db') {
  const dbPath = path.join(dir, name);
  const writer = new DatabaseSync(dbPath);
  writers.push(writer);
  writer.exec('PRAGMA journal_mode = WAL');
  writer.exec('CREATE TABLE note(text TEXT)');
  writer.exec("INSERT INTO note VALUES ('only in the wal')");
  return dbPath;
}

// `os.tmpdir()` reads TMPDIR on every call, so redirecting it at an empty dir
// of our own turns "did a temp dir leak?" into a directory listing. Restored
// afterwards, and safe to set: `node --test` runs each file in its own process,
// and the tests within one file in order.
function withRedirectedTmpdir(body) {
  const own = makeScratch();
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    body(own);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
}

after(() => {
  for (const w of writers) { try { w.close(); } catch { /* already closed */ } }
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('openSnapshot', () => {
  test('copies the store with its -wal and -shm sidecars, so an uncheckpointed row is readable', () => {
    const dbPath = makeLiveStore(makeScratch());
    // The premise: the `.db` file alone does not yet hold the row.
    assert.ok(fs.existsSync(dbPath + '-wal'), 'fixture should have a -wal sidecar');
    assert.ok(fs.existsSync(dbPath + '-shm'), 'fixture should have a -shm sidecar');

    const snap = openSnapshot(dbPath);
    try {
      assert.deepEqual(
        snap.db.prepare('SELECT text FROM note').all().map((r) => r.text),
        ['only in the wal'],
      );
    } finally {
      snap.cleanup();
    }
  });

  test('opens the copy, never the original: the store and its sidecars are untouched', () => {
    const dbPath = makeLiveStore(makeScratch());
    const before = [dbPath, dbPath + '-wal', dbPath + '-shm'].map((p) => ({ p, st: fs.statSync(p) }));

    const snap = openSnapshot(dbPath);
    snap.db.prepare('SELECT text FROM note').all();
    snap.cleanup();

    for (const { p, st } of before) {
      const now = fs.statSync(p);
      assert.equal(now.mtimeMs, st.mtimeMs, `${path.basename(p)} mtime must not move`);
      assert.equal(now.size, st.size, `${path.basename(p)} size must not change`);
    }
  });

  test('cleanup drops the temp copy', () => {
    const dbPath = makeLiveStore(makeScratch());
    withRedirectedTmpdir((tmpRoot) => {
      const snap = openSnapshot(dbPath);
      assert.equal(fs.readdirSync(tmpRoot).length, 1, 'the snapshot should be one temp dir');

      snap.cleanup();

      assert.deepEqual(fs.readdirSync(tmpRoot), [], 'cleanup should remove the temp dir');
    });
  });

  test('a store that cannot be copied throws and leaves no temp dir behind', () => {
    const missing = path.join(makeScratch(), 'not-there.db');
    withRedirectedTmpdir((tmpRoot) => {
      assert.throws(() => openSnapshot(missing), /ENOENT/);

      assert.deepEqual(fs.readdirSync(tmpRoot), [],
        'a copy that never completed still made the temp dir; it should not outlive the throw');
    });
  });
});

// The removal half: one home only holds if there is nowhere for a second copy
// to live. The same shape as test/tool-labels-single-home.test.mjs.
function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared')]
  .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

describe('one home for the snapshot helper', () => {
  test('openSnapshot and the Snapshot shape are declared only in server/parsers/source.ts', () => {
    for (const decl of [/(?:^|\n)\s*(?:export )?function openSnapshot\b/, /(?:^|\n)\s*(?:export )?interface Snapshot\b/]) {
      const declares = SOURCES.filter(({ text }) => decl.test(text)).map(({ rel }) => rel);
      assert.deepEqual(declares, ['server/parsers/source.ts'],
        `${decl} should be declared only in server/parsers/source.ts`);
    }
  });

  test('mkdtempSync for a store copy happens only in the one helper', () => {
    const copiers = SOURCES
      .filter(({ text }) => /mkdtempSync/.test(text))
      .map(({ rel }) => rel);
    assert.deepEqual(copiers, ['server/parsers/source.ts'],
      'a second temp-copy is a second read-only guarantee to keep in step');
  });

  // The two store-backed sources. Each reaches for the shared helper rather
  // than its own, so a fix to the read-only guarantee lands for both.
  for (const rel of ['server/parsers/cursor.ts', 'server/parsers/opencode.ts']) {
    test(`${path.basename(rel)} opens its store through the shared helper`, () => {
      const { text } = SOURCES.find((s) => s.rel === rel);
      assert.match(text, /import \{[^}]*\bopenSnapshot\b[^}]*\} from '\.\/source\.ts'/,
        `${rel} should import openSnapshot from ./source.ts`);
      assert.match(text, /openSnapshot\(/, `${rel} should still open its store through the helper`);
    });
  }
});
