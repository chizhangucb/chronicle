// Characterization tests for server/causality.js. This module imports the
// module-scope `db` from server/db.js, which reads process.env.CHRONICLE_DATA_DIR
// AT IMPORT TIME and opens <dir>/chronicle.db immediately. test/helpers.mjs
// sets that env var and dynamically imports db.js BEFORE we dynamically
// import causality.js, so causality's own `import { db } from './db.js'`
// resolves to the same already-initialized, temp-dir-backed module instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let db;
let analyzeCausality;
let teardown;

const SESSION_ID = 'session-causality-1';

function insertToolUse(seq, ts, toolName, input) {
  db.prepare(
    `INSERT INTO messages (session_id, seq, ts, kind, tool_name, tool_input) VALUES (?, ?, ?, 'tool_use', ?, ?)`
  ).run(SESSION_ID, seq, ts, toolName, JSON.stringify(input));
}

before(async () => {
  const temp = await withTempDb();
  db = temp.dbModule.db;
  teardown = temp.teardown;
  ({ analyzeCausality } = await import('../server/causality.ts'));

  // messages.session_id has a FOREIGN KEY REFERENCES sessions(id), and
  // sessions.project_id REFERENCES projects(id) NOT NULL — node:sqlite
  // enforces these, so seed a minimal project + session row first.
  const project = temp.dbModule.upsertProject('/proj');
  db.prepare(
    `INSERT INTO sessions (id, project_id, source, file_path, message_count) VALUES (?, ?, 'claude-code', '/proj/session.jsonl', 0)`
  ).run(SESSION_ID, project.id);

  // One change (Edit of /proj/src/target.js) preceded by five reads, each
  // engineered to land in exactly one confidence tier:
  //   seq 1: Read /proj/src/target.js          -> 0.95 (exact same file)
  //   seq 2: Read /proj/src/sibling.js         -> 0.55 (sibling, same dir)
  //   seq 3: Read /proj/other/target.txt       -> 0.50 (same stem, diff dir)
  //   seq 4: Grep pattern "target"             -> 0.45 (pattern matches file)
  //   seq 5: Read /proj/misc/note.md           -> 0.20 (unrelated, within window)
  //   seq 6: Edit /proj/src/target.js          <- the change
  insertToolUse(1, '2026-01-01T00:00:01.000Z', 'Read', { file_path: '/proj/src/target.js' });
  insertToolUse(2, '2026-01-01T00:00:02.000Z', 'Read', { file_path: '/proj/src/sibling.js' });
  insertToolUse(3, '2026-01-01T00:00:03.000Z', 'Read', { file_path: '/proj/other/target.txt' });
  insertToolUse(4, '2026-01-01T00:00:04.000Z', 'Grep', { pattern: 'target' });
  insertToolUse(5, '2026-01-01T00:00:05.000Z', 'Read', { file_path: '/proj/misc/note.md' });
  insertToolUse(6, '2026-01-01T00:00:06.000Z', 'Edit', { file_path: '/proj/src/target.js' });
});

after(() => {
  teardown();
});

test('analyzeCausality: exact-file read before a change scores 0.95', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  const src = change.sources.find((s) => s.seq === 1);
  assert.equal(src.confidence, 0.95);
  assert.equal(src.file, '/proj/src/target.js');
});

test('analyzeCausality: sibling-file read (same dirname) scores 0.55', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  const src = change.sources.find((s) => s.seq === 2);
  assert.equal(src.confidence, 0.55);
  assert.equal(src.file, '/proj/src/sibling.js');
});

test('analyzeCausality: same-basename read in a different directory scores 0.5', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  const src = change.sources.find((s) => s.seq === 3);
  assert.equal(src.confidence, 0.5);
  assert.equal(src.file, '/proj/other/target.txt');
});

test('analyzeCausality: a Grep pattern matching the changed file scores 0.45', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  const src = change.sources.find((s) => s.seq === 4);
  assert.equal(src.confidence, 0.45);
  assert.equal(src.pattern, 'target');
  assert.equal(src.tool, 'Grep');
});

test('analyzeCausality: an unrelated read within the last-8 window scores 0.2', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  const src = change.sources.find((s) => s.seq === 5);
  assert.equal(src.confidence, 0.2);
  assert.equal(src.file, '/proj/misc/note.md');
});

test('analyzeCausality: change.sources is sorted by confidence desc, one entry per read seq (deduped)', () => {
  const result = analyzeCausality(SESSION_ID);
  const change = result.changes.find((c) => c.seq === 6);
  assert.equal(change.sources.length, 5);
  const confidences = change.sources.map((s) => s.confidence);
  assert.deepEqual(confidences, [0.95, 0.55, 0.5, 0.45, 0.2]);
  const seqs = change.sources.map((s) => s.seq);
  assert.deepEqual(new Set(seqs).size, seqs.length, 'no duplicate read seq in sources');
});

test('analyzeCausality: readCount counts every tool_use classified as a read', () => {
  const result = analyzeCausality(SESSION_ID);
  assert.equal(result.readCount, 5);
});

test('analyzeCausality: mentioned maps each message seq to its referenced file(s)', () => {
  const result = analyzeCausality(SESSION_ID);
  assert.deepEqual(result.mentioned[1], ['/proj/src/target.js']);
  assert.deepEqual(result.mentioned[2], ['/proj/src/sibling.js']);
  assert.deepEqual(result.mentioned[3], ['/proj/other/target.txt']);
  assert.deepEqual(result.mentioned[5], ['/proj/misc/note.md']);
  // The change itself is also recorded in `mentioned` under its own seq.
  assert.deepEqual(result.mentioned[6], ['/proj/src/target.js']);
  // The Grep call (seq 4) has no file_path, so it contributes no entry.
  assert.equal(result.mentioned[4], undefined);
});
