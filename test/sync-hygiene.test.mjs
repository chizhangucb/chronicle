// Characterization tests for Phase 5 PR 5a "sync hygiene": tombstones + undo
// (server/db.ts), the noise gate (server/noiseGate.ts, applied inside
// replaceSession), and the auto-sync pause flag (server/autosync.ts).
//
// One shared temp DB for the whole file (module caching means a second
// withTempDb() call in the same file would NOT rebind to a fresh dir — see
// test/helpers.mjs and test/causality.test.mjs for the same pattern), so
// each test below uses its own session/project ids to stay independent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withTempDb } from './helpers.mjs';

const SOURCE = 'claude-code';

let dbModule;
let dir;
let teardown;
let autosync;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  dir = temp.dir;
  teardown = temp.teardown;
  // autosync.ts imports { db, upsertProject, replaceSession } from './db.ts'
  // (a bare relative specifier) — same resolved URL as helpers.mjs already
  // imported, so it binds to the SAME already-temp-dir-backed db instance.
  autosync = await import('../server/autosync.ts');
});

after(() => {
  teardown();
});

function baseEvents(n) {
  // n messages, one minute apart, so agent_active_ms comfortably clears the
  // default 5-min / 10-message minor thresholds.
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({ kind: i % 2 === 0 ? 'assistant' : 'user', text: `msg ${i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString() });
  }
  return events;
}

function tinyEvents() {
  return [
    { kind: 'user', text: 'hi', ts: '2026-01-01T00:00:00.000Z' },
    { kind: 'assistant', text: 'hello', ts: '2026-01-01T00:00:01.000Z' },
  ];
}

function simulateDelete(sessionId) {
  dbModule.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  dbModule.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ---------------------------------------------------------------------------
// Tombstones + undo
// ---------------------------------------------------------------------------

test('tombstones: a deleted (tombstoned) session is not resurrected by a subsequent import of the same source file', () => {
  const { upsertProject, replaceSession, tombstoneSession, isTombstoned } = dbModule;
  const project = upsertProject('/proj-tombstone');
  const session = { id: 's-tomb-1', project_id: project.id, source: SOURCE, file_path: '/proj-tombstone/s1.jsonl' };
  const events = baseEvents(20);

  // First import: the session lands normally.
  replaceSession(session, events);
  assert.ok(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), 'session should exist after first import');

  // Simulate the delete route: remove the row, write the tombstone.
  simulateDelete(session.id);
  tombstoneSession(SOURCE, session.id);
  assert.equal(isTombstoned(SOURCE, session.id), true);

  // A later scan of the SAME source file re-parses the same session — the
  // resulting replaceSession call must be a no-op.
  replaceSession(session, events);
  assert.equal(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), undefined,
    'a tombstoned session must not be resurrected by re-import');
});

test('tombstones: undo (removeTombstone) clears the tombstone so the next import succeeds', () => {
  const { upsertProject, replaceSession, tombstoneSession, removeTombstone, isTombstoned } = dbModule;
  const project = upsertProject('/proj-undo');
  const session = { id: 's-undo-1', project_id: project.id, source: SOURCE, file_path: '/proj-undo/s1.jsonl' };
  const events = baseEvents(20);

  replaceSession(session, events);
  simulateDelete(session.id);
  tombstoneSession(SOURCE, session.id);
  assert.equal(isTombstoned(SOURCE, session.id), true);

  // Still gone while tombstoned.
  replaceSession(session, events);
  assert.equal(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), undefined);

  // Undo: clear the tombstone, then the next import brings it back.
  removeTombstone(SOURCE, session.id);
  assert.equal(isTombstoned(SOURCE, session.id), false);
  replaceSession(session, events);
  assert.ok(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), 'session should be re-imported after undo');
});

test('tombstones: deleting a whole project tombstones every one of its sessions', () => {
  const { upsertProject, replaceSession, tombstoneSessionsForProject, isTombstoned } = dbModule;
  const project = upsertProject('/proj-bulk');
  const s1 = { id: 's-bulk-1', project_id: project.id, source: SOURCE, file_path: '/proj-bulk/s1.jsonl' };
  const s2 = { id: 's-bulk-2', project_id: project.id, source: SOURCE, file_path: '/proj-bulk/s2.jsonl' };
  replaceSession(s1, baseEvents(20));
  replaceSession(s2, baseEvents(20));

  tombstoneSessionsForProject(project.id);
  assert.equal(isTombstoned(SOURCE, s1.id), true);
  assert.equal(isTombstoned(SOURCE, s2.id), true);
});

// ---------------------------------------------------------------------------
// Noise gate
// ---------------------------------------------------------------------------

test('noise gate: a sub-threshold session (few messages, short active time) is gated (minor = 1) on import', () => {
  const { upsertProject, replaceSession } = dbModule;
  const project = upsertProject('/proj-noise');
  const session = { id: 's-noise-1', project_id: project.id, source: SOURCE, file_path: '/proj-noise/s1.jsonl' };
  replaceSession(session, tinyEvents());
  const row = dbModule.db.prepare('SELECT minor FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.minor, 1);
});

test('noise gate: an above-threshold session is NOT gated (minor = 0) on import', () => {
  const { upsertProject, replaceSession } = dbModule;
  const project = upsertProject('/proj-noise-2');
  const session = { id: 's-noise-2', project_id: project.id, source: SOURCE, file_path: '/proj-noise-2/s1.jsonl' };
  replaceSession(session, baseEvents(20)); // 20 messages, ~19 min of active spread
  const row = dbModule.db.prepare('SELECT minor FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.minor, 0);
});

test('noise gate: promote (minor -> 0) sticks across a subsequent re-import', () => {
  const { upsertProject, replaceSession } = dbModule;
  const project = upsertProject('/proj-promote');
  const session = { id: 's-promote-1', project_id: project.id, source: SOURCE, file_path: '/proj-promote/s1.jsonl' };
  const events = tinyEvents();
  replaceSession(session, events); // gated: minor = 1
  assert.equal(dbModule.db.prepare('SELECT minor FROM sessions WHERE id = ?').get(session.id).minor, 1);

  // Promote (server/routes/sessions.ts POST /sessions/:id/promote does exactly this).
  dbModule.db.prepare('UPDATE sessions SET minor = 0 WHERE id = ?').run(session.id);

  // A later re-import of the SAME (still short) session must not re-gate it.
  replaceSession(session, events);
  assert.equal(dbModule.db.prepare('SELECT minor FROM sessions WHERE id = ?').get(session.id).minor, 0,
    'promote should stick across re-import, not be recomputed back to minor');
});

test('noise gate: ignore tombstones the session (same mechanism as delete)', () => {
  const { upsertProject, replaceSession, tombstoneSession, isTombstoned } = dbModule;
  const project = upsertProject('/proj-ignore');
  const session = { id: 's-ignore-1', project_id: project.id, source: SOURCE, file_path: '/proj-ignore/s1.jsonl' };
  replaceSession(session, tinyEvents());

  // "Ignore" in the minor-sessions bucket == the same delete-then-tombstone flow.
  simulateDelete(session.id);
  tombstoneSession(SOURCE, session.id);

  assert.equal(isTombstoned(SOURCE, session.id), true);
  assert.equal(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), undefined);
});

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

test('pause: runIncrementalSync no-ops (does not scan or import anything) while paused', async () => {
  autosync.writeConfig({ autoSyncPaused: true });
  assert.equal(autosync.autoSyncPaused(), true);

  const before_ = dbModule.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const result = await autosync.runIncrementalSync();
  const after_ = dbModule.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;

  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'paused');
  assert.equal(after_, before_, 'no session should be imported while paused');
  // Sanity: the config file really lives under the temp data dir, not ~/.chronicle.
  assert.ok(fs.existsSync(`${dir}/config.json`));

  autosync.writeConfig({ autoSyncPaused: false }); // leave clean for any later test
});

test('pause: unpausing clears the flag', () => {
  autosync.writeConfig({ autoSyncPaused: true });
  assert.equal(autosync.autoSyncPaused(), true);
  autosync.writeConfig({ autoSyncPaused: false });
  assert.equal(autosync.autoSyncPaused(), false);
});
